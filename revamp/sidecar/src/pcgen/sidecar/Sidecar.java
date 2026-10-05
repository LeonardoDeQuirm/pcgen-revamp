package pcgen.sidecar;

import java.io.File;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import pcgen.core.Campaign;
import pcgen.core.Globals;
import pcgen.core.SystemCollections;
import pcgen.facade.core.SourceSelectionFacade;
import pcgen.persistence.SourceFileLoader;
import pcgen.system.CharacterManager;
import pcgen.system.FacadeFactory;
import pcgen.system.Main;
import pcgen.system.SidecarBootstrap;
import pcgen.util.Logging;
import pcgen.util.chooser.ChooserFactory;

/**
 * Local sidecar API over the PCGen engine.
 * <p>
 * The engine keeps global static state and is not thread-safe, and loads one data set per
 * JVM. So: one process = one game mode + source set (loaded once at startup), and every
 * engine call runs on a single worker thread. HTTP threads only parse requests and wait
 * on the worker.
 * <p>
 * Choosers: the engine asks questions synchronously in the middle of an operation. When that
 * happens the worker blocks and the HTTP call that started the operation returns 202 with the
 * question. The client answers with POST /choosers/{id}; that call resumes the worker and
 * returns the operation's final result (or the next question). Only one operation runs at a
 * time; others get 409 until it finishes.
 * <p>
 * Routes live in the *Routes classes; this class owns startup, HTTP and the operation lifecycle.
 * <p>
 * Bound to loopback only. There is no authentication, so do not expose it further.
 */
public final class Sidecar
{
	/** Requests slower than this are logged, so latency regressions are visible. */
	private static final long SLOW_REQUEST_MS = 500;

	private final ExecutorService worker = Executors.newSingleThreadExecutor(r -> new Thread(r, "engine-worker"));
	private final RecordingUIDelegate ui = new RecordingUIDelegate();
	private final Session session = new Session(ui);
	private final Router router = new Router();
	private final long startedAt = System.currentTimeMillis();
	private Operation current; // guarded by this
	private HttpServer server;
	/** Host headers we answer to (stops DNS-rebinding pages from reading us) and origins allowed to call us. */
	private Set<String> allowedHosts = Set.of();
	private Set<String> allowedOrigins = Set.of();
	private volatile String pdfWarmup = "pending"; // pending, running, done or disabled

	/** An in-flight engine call. Its events are either a chooser the engine waits on, or Done. */
	static final class Operation
	{
		/** Background work (the PDF warm-up): never parks on a question, answers them itself. */
		final boolean silent;
		final BlockingQueue<Object> events = new LinkedBlockingQueue<>();
		volatile RecordingUIDelegate.PendingChooser pending;
		volatile RecordingUIDelegate.PendingBuilder builder;
		volatile RecordingUIDelegate.PendingConfirm confirm;
		/** The engine side is over (its result is queued). Normally the request that is waiting takes the result and frees the slot;
		 * when nobody is (the question expired after the person walked away), the next request frees it. */
		volatile boolean finished;

		Operation(boolean silent)
		{
			this.silent = silent;
		}

		/** True while the engine is stopped waiting for a person to answer something. */
		boolean isParked()
		{
			return pending != null || builder != null || confirm != null;
		}
	}

	private record Done(Object result, Throwable error)
	{
	}

	/** A non-200 success-path response (e.g. 202 when the engine needs a choice). */
	private record Reply(int status, Object body)
	{
	}

	public static void main(String[] argv) throws Exception
	{
		Map<String, String> args = parseArgs(argv);
		String settings = args.get("settings-dir");
		if (settings == null)
		{
			System.err.println("usage: Sidecar --settings-dir DIR (--from-character FILE.pcg | "
					+ "--game-mode MODE --sources A,B) [--port 8765|0] [--extra-sources A,B] [--allow-origin URL,URL] [--ui-dir DIR] [--token SECRET]");
			System.exit(2);
		}
		Sidecar s = new Sidecar();
		try
		{
			s.worker.submit(() -> {
				s.bootstrap(Path.of(settings).toAbsolutePath().toString());
				s.loadSources(args);
				return null;
			}).get();
			s.registerRoutes();
			s.uiDir = args.containsKey("ui-dir") ? Path.of(args.get("ui-dir")).toRealPath() : null;
			s.token = args.get("token");
			s.startHttp(Integer.parseInt(args.getOrDefault("port", "8765")), args.get("allow-origin"));
		}
		catch (Throwable t)
		{
			Logging.errorPrint("Sidecar failed to start", t);
			System.err.println("startup failed: " + t);
			System.exit(1);
		}
	}

	private static Map<String, String> parseArgs(String[] argv)
	{
		Map<String, String> m = new LinkedHashMap<>();
		for (int i = 0; i + 1 < argv.length; i += 2)
		{
			m.put(argv[i].replaceFirst("^--", ""), argv[i + 1]);
		}
		return m;
	}

	// ---- engine bootstrap (mirrors Main.main + startupWithoutGUI; runs on the worker) ----

	private void bootstrap(String settingsDir)
	{
		new File(settingsDir).mkdirs();
		SidecarBootstrap.initSettings(settingsDir);
		// Only the GUI sets this; without it any chooser in the core throws a NullPointerException.
		ChooserFactory.setDelegate(ui);
		ui.setCurrentOperation(() -> {
			synchronized (this)
			{
				return current;
			}
		});
		Main.runBootstrapTasks();
	}

	private void loadSources(Map<String, String> args)
	{
		if (args.containsKey("from-character"))
		{
			SourceSelectionFacade sel =
					CharacterManager.getRequiredSourcesForCharacter(new File(args.get("from-character")), ui);
			if (sel == null)
			{
				throw new IllegalStateException(
						"cannot read sources from " + args.get("from-character") + ": " + ui.drain());
			}
			session.gameMode = sel.getGameMode().get();
			session.campaigns = new ArrayList<>();
			sel.getCampaigns().forEach(session.campaigns::add);
		}
		else
		{
			session.gameMode = SystemCollections.getGameModeNamed(args.getOrDefault("game-mode", ""));
			if (session.gameMode == null)
			{
				throw new IllegalStateException("unknown game mode: " + args.get("game-mode"));
			}
			session.campaigns = new ArrayList<>();
			for (String name : args.getOrDefault("sources", "").split(","))
			{
				if (name.isBlank())
				{
					continue;
				}
				Campaign c = Globals.getCampaignKeyedSilently(name.trim());
				if (c == null)
				{
					throw new IllegalStateException("unknown campaign: " + name);
				}
				session.campaigns.add(c);
			}
		}
		// Books to load on top of the character's own (so its gods, classes... are on offer): --extra-sources A,B
		if (args.containsKey("extra-sources"))
		{
			for (String name : args.get("extra-sources").split(","))
			{
				if (name.isBlank())
				{
					continue;
				}
				Campaign c = Globals.getCampaignKeyedSilently(name.trim());
				if (c == null)
				{
					throw new IllegalStateException("unknown source book in --extra-sources: " + name);
				}
				if (!session.campaigns.contains(c))
				{
					session.campaigns.add(c);
				}
			}
		}
		session.loader = new SourceFileLoader(ui,
				FacadeFactory.createSourceSelection(session.gameMode, session.campaigns).getCampaigns(),
				session.gameMode.getName());
		session.loader.run();
		Logging.log(Logging.INFO,
				"Sidecar sources loaded: " + session.gameMode.getName() + " " + session.campaignNames());
	}

	private void registerRoutes()
	{
		CharacterRoutes characters = new CharacterRoutes(session);
		characters.register(router);
		new AbilityRoutes(session, characters).register(router);
		new SkillRoutes(session, characters).register(router);
		new EquipmentRoutes(session, characters).register(router);
		new SpellRoutes(session, characters).register(router);
		new DescriptionRoutes(session, characters).register(router);
		new LanguageRoutes(session, characters).register(router);
		new ExportRoutes(session).register(router);
		new AttackRoutes(session).register(router);
		new DatasetRoutes(session).register(router);
		new InfoRoutes(session).register(router);
		new DomainRoutes(session).register(router);
		new FileRoutes().register(router);
		router.get("/messages", q -> ui.drain());
		router.get("/routes", q -> router.describe());
	}

	// ---- HTTP ----

	/** Folder holding the built UI to serve at "/" (packaged app); null in development, where Vite serves it. */
	private Path uiDir;
	/** When set, every API call must carry it in the X-Pcgen-Token header (the desktop shell passes it to its window). */
	private String token;

	/** The path of an API call: the UI reaches the API under /api/, direct callers (tests, the shell) may omit it. */
	private static String apiPath(String path)
	{
		return path.startsWith("/api/") ? path.substring(4) : path;
	}

	private static final Map<String, String> STATIC_TYPES = Map.ofEntries(Map.entry("html", "text/html; charset=utf-8"),
			Map.entry("js", "text/javascript; charset=utf-8"), Map.entry("css", "text/css; charset=utf-8"),
			Map.entry("svg", "image/svg+xml"), Map.entry("png", "image/png"), Map.entry("ico", "image/x-icon"),
			Map.entry("woff2", "font/woff2"), Map.entry("json", "application/json"), Map.entry("map", "application/json"));

	/**
	 * Serves a file of the built UI. Only GET of a file that really lives inside the UI folder (symlinks and ..
	 * resolved); anything else is left to the API. Returns false when this was not a UI request.
	 */
	private boolean serveStatic(HttpExchange ex) throws IOException
	{
		String path = ex.getRequestURI().getPath();
		if (uiDir == null || !ex.getRequestMethod().equals("GET") || path.startsWith("/api/"))
		{
			return false;
		}
		Path file;
		try
		{
			file = uiDir.resolve(path.equals("/") ? "index.html" : path.substring(1)).toRealPath();
		}
		catch (IOException | java.nio.file.InvalidPathException e)
		{
			return false;
		}
		if (!file.startsWith(uiDir) || !java.nio.file.Files.isRegularFile(file))
		{
			return false;
		}
		String name = file.getFileName().toString();
		String type = STATIC_TYPES.getOrDefault(name.substring(name.lastIndexOf('.') + 1).toLowerCase(java.util.Locale.ROOT),
				"application/octet-stream");
		byte[] bytes = java.nio.file.Files.readAllBytes(file);
		ex.getResponseHeaders().set("Content-Type", type);
		ex.sendResponseHeaders(200, bytes.length);
		try (var out = ex.getResponseBody())
		{
			out.write(bytes);
		}
		return true;
	}

	private void requireToken(HttpExchange ex)
	{
		if (token == null)
		{
			return;
		}
		String given = ex.getRequestHeaders().getFirst("X-Pcgen-Token");
		if (given == null || !java.security.MessageDigest.isEqual(given.getBytes(StandardCharsets.UTF_8),
				token.getBytes(StandardCharsets.UTF_8)))
		{
			throw new ApiException(403, "missing or wrong access token");
		}
	}

	private void startHttp(int port, String extraOrigins) throws IOException
	{
		server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 0);
		port = server.getAddress().getPort(); // port 0 asks the system for a free one
		allowedHosts = Set.of("127.0.0.1:" + port, "localhost:" + port, "[::1]:" + port);
		// The UI dev server (and its proxy) is the normal caller. Anything else must be named explicitly.
		Set<String> origins = new java.util.HashSet<>(List.of("http://127.0.0.1:5173", "http://localhost:5173",
				"http://127.0.0.1:" + port, "http://localhost:" + port));
		if (extraOrigins != null)
		{
			for (String o : extraOrigins.split(","))
			{
				if (!o.isBlank())
				{
					origins.add(o.trim());
				}
			}
		}
		allowedOrigins = Set.copyOf(origins);
		server.createContext("/", this::handle);
		// One thread per request. Engine work is still one at a time (see runOp), but /health, answering a
		// question and /shutdown must never queue behind a slow export.
		server.setExecutor(Executors.newCachedThreadPool(new java.util.concurrent.ThreadFactory()
		{
			private final java.util.concurrent.atomic.AtomicInteger n = new java.util.concurrent.atomic.AtomicInteger();

			@Override
			public Thread newThread(Runnable r)
			{
				Thread t = new Thread(r, "http-" + n.incrementAndGet());
				t.setDaemon(true);
				return t;
			}
		}));
		server.start();
		System.out.println("READY http://127.0.0.1:" + port);
		// After READY so startup isn't slower; requests that arrive meanwhile wait their turn behind it.
		if ("false".equals(System.getProperty("sidecar.warmup")))
		{
			pdfWarmup = "disabled";
		}
		else
		{
			pdfWarmup = "running";
			Thread warm = new Thread(() -> {
				try
				{
					// A real operation, so a request that arrives meanwhile queues instead of being handed the
					// warm-up's questions; silent, so the warm-up can never wait on a person.
					runOp(() -> {
						ExportRoutes.warmUp(session);
						return null;
					}, true);
				}
				catch (Exception e)
				{
					Logging.log(Logging.WARNING, "PDF warm-up did not run: " + e);
				}
				finally
				{
					pdfWarmup = "done";
				}
			}, "pdf-warmup");
			warm.setDaemon(true);
			warm.start();
		}
	}

	/**
	 * Rejects requests that did not come from us or from the UI. The server listens on loopback only, but a web
	 * page the user visits can still make their browser call it. Three checks: the Host header (DNS rebinding),
	 * the Origin header (a page on another site), and Sec-Fetch-Site (the browser's own statement).
	 */
	private void guardCaller(HttpExchange ex)
	{
		String host = ex.getRequestHeaders().getFirst("Host");
		if (host != null && !allowedHosts.contains(host.toLowerCase(java.util.Locale.ROOT)))
		{
			throw new ApiException(403, "unexpected Host header");
		}
		String origin = ex.getRequestHeaders().getFirst("Origin");
		if (origin != null && !allowedOrigins.contains(origin))
		{
			throw new ApiException(403, "requests from " + origin + " are not allowed");
		}
		if ("cross-site".equalsIgnoreCase(ex.getRequestHeaders().getFirst("Sec-Fetch-Site")))
		{
			throw new ApiException(403, "cross-site requests are not allowed");
		}
	}

	private void handle(HttpExchange ex) throws IOException
	{
		long t0 = System.nanoTime();
		int status = 200;
		String contentType = "application/json";
		byte[] body;
		try
		{
			guardCaller(ex);
			if (serveStatic(ex))
			{
				return;
			}
			requireToken(ex);
			Object result = dispatch(ex);
			if (result instanceof Reply reply)
			{
				status = reply.status();
				result = reply.body();
			}
			if (result instanceof ExportRoutes.Binary file)
			{
				contentType = file.contentType();
				body = file.bytes();
			}
			else
			{
				body = Json.write(result).getBytes(StandardCharsets.UTF_8);
			}
		}
		catch (ApiException e)
		{
			status = e.status;
			body = Json.write(Map.of("error", e.getMessage())).getBytes(StandardCharsets.UTF_8);
		}
		catch (Throwable t)
		{
			Logging.errorPrint("request failed: " + ex.getRequestMethod() + " " + ex.getRequestURI(), t);
			status = 500;
			body = Json.write(Map.of("error", String.valueOf(t))).getBytes(StandardCharsets.UTF_8);
		}
		long ms = (System.nanoTime() - t0) / 1_000_000;
		if (ms >= SLOW_REQUEST_MS)
		{
			Logging.log(Logging.WARNING, "slow request (" + ms + " ms): " + ex.getRequestMethod() + " "
					+ apiPath(ex.getRequestURI().getPath()));
		}
		ex.getResponseHeaders().set("Content-Type", contentType);
		ex.getResponseHeaders().set("X-Time-Ms", Long.toString(ms));
		ex.sendResponseHeaders(status, body.length);
		try (var out = ex.getResponseBody())
		{
			out.write(body);
		}
		if (status == 200 && apiPath(ex.getRequestURI().getPath()).equals("/shutdown"))
		{
			shutdown();
		}
	}

	private void shutdown()
	{
		server.stop(0);
		worker.shutdown();
		Main.shutdown(true);
	}

	private static Map<String, String> query(URI uri)
	{
		Map<String, String> q = new LinkedHashMap<>();
		String raw = uri.getRawQuery();
		if (raw != null)
		{
			for (String pair : raw.split("&"))
			{
				int eq = pair.indexOf('=');
				String k = eq < 0 ? pair : pair.substring(0, eq);
				String v = eq < 0 ? "" : pair.substring(eq + 1);
				try
				{
					q.put(URLDecoder.decode(k, StandardCharsets.UTF_8), URLDecoder.decode(v, StandardCharsets.UTF_8));
				}
				catch (IllegalArgumentException e)
				{
					throw new ApiException(400, "malformed query string (bad % escape)");
				}
			}
		}
		return q;
	}

	@SuppressWarnings("unchecked")
	private static Map<String, Object> readBody(HttpExchange ex) throws IOException
	{
		String text = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
		if (text.isBlank())
		{
			return Map.of();
		}
		try
		{
			Object parsed = JsonReader.parse(text);
			if (parsed instanceof Map<?, ?> m)
			{
				return (Map<String, Object>) m;
			}
			throw new ApiException(400, "request body must be a JSON object");
		}
		catch (IllegalArgumentException e)
		{
			throw new ApiException(400, e.getMessage());
		}
	}

	/**
	 * Engine calls go through {@link #runOp}. Requests that must work while the worker is blocked
	 * on a chooser (answering it, health, shutdown) are handled on the HTTP thread instead.
	 */
	private Object dispatch(HttpExchange ex) throws Exception
	{
		String method = ex.getRequestMethod();
		URI uri = ex.getRequestURI();
		String path = apiPath(uri.getPath());
		Map<String, String> query = query(uri);
		Map<String, Object> body = readBody(ex);

		if (path.startsWith("/choosers/") && method.equals("POST"))
		{
			return answerChooser(path.substring("/choosers/".length()),
					new Request(method, path, Map.of(), query, body));
		}
		if (path.startsWith("/confirms/") && method.equals("POST"))
		{
			return answerConfirm(path.substring("/confirms/".length()), new Request(method, path, Map.of(), query, body));
		}
		if (path.equals("/builder") || path.startsWith("/builder/"))
		{
			Operation op;
			synchronized (this)
			{
				op = current;
			}
			Request request = new Request(method, path, Map.of(), query, body);
			Object result = BuilderRoutes.handle(op == null ? null : op.builder, request, session);
			// commit/cancel let the parked operation finish; hand back its outcome.
			return result == BuilderRoutes.FINISHED || result == BuilderRoutes.EDITING ? awaitEvent(op) : result;
		}
		if (path.equals("/health") && method.equals("GET"))
		{
			return health();
		}
		if (path.equals("/shutdown") && method.equals("POST"))
		{
			return Map.of("status", "shutting down");
		}
		Router.Match match = router.match(method, path);
		if (match == null)
		{
			throw router.pathExists(path) ? new ApiException(405, method + " is not supported for " + path)
					: new ApiException(404, "no route for " + method + " " + path + " (see GET /routes)");
		}
		Request request = new Request(method, path, match.params(), query, body);
		return runOp(() -> match.handler().handle(request));
	}

	private Object runOp(Callable<Object> task) throws Exception
	{
		return runOp(task, false);
	}

	/**
	 * Runs one engine operation at a time. A request that arrives while another is running simply waits its turn
	 * (slow is fine). The exception is an operation that is parked on a question for a person: nothing can run
	 * until it is answered, so waiting would hang for as long as the person takes; those requests get a 409.
	 */
	private Object runOp(Callable<Object> task, boolean silent) throws Exception
	{
		Operation op = new Operation(silent);
		synchronized (this)
		{
			while (current != null)
			{
				if (current.finished && current.events.stream().allMatch(e -> e instanceof Done))
				{
					// Orphaned: its question expired and nobody came back for the result.
					current = null;
					break;
				}
				if (current.isParked())
				{
					RecordingUIDelegate.PendingChooser p = current.pending;
					RecordingUIDelegate.PendingBuilder b = current.builder;
					RecordingUIDelegate.PendingConfirm k = current.confirm;
					throw new ApiException(409, "another operation is in progress"
							+ (k == null ? "" : "; it is waiting for a yes/no answer (" + k.id + ")")
							+ (p == null ? "" : "; it is waiting on chooser " + p.id)
							+ (b == null ? "" : "; it is waiting on the custom equipment builder (see /builder)"));
				}
				wait();
			}
			current = op;
		}
		worker.submit(() -> {
			Object result = null;
			Throwable error = null;
			try
			{
				result = task.call();
			}
			catch (Throwable t)
			{
				error = t;
			}
			op.events.add(new Done(result, error));
			op.finished = true;
			synchronized (Sidecar.this)
			{
				Sidecar.this.notifyAll();
			}
		});
		return awaitEvent(op);
	}

	private Object awaitEvent(Operation op) throws Exception
	{
		Object event = op.events.take();
		synchronized (this)
		{
			// Parked or finished: either way, requests waiting for their turn need to look again.
			notifyAll();
		}
		if (event instanceof RecordingUIDelegate.PendingConfirm k)
		{
			Map<String, Object> body = new LinkedHashMap<>();
			body.put("pendingConfirm", Map.of("id", k.id, "title", k.title, "message", k.message));
			body.put("answerWith", "POST /confirms/" + k.id + " {ok: true|false}");
			return new Reply(202, body);
		}
		if (event instanceof RecordingUIDelegate.PendingBuilder b)
		{
			Map<String, Object> body = new LinkedHashMap<>();
			body.put("pendingBuilder", BuilderRoutes.describe(b));
			body.put("answerWith", "edit via /builder (modifiers, properties), then POST /builder/commit or /builder/cancel");
			return new Reply(202, body);
		}
		if (event instanceof RecordingUIDelegate.PendingChooser p)
		{
			Map<String, Object> body = new LinkedHashMap<>();
			body.put("pendingChooser", RecordingUIDelegate.describe(p));
			body.put("answerWith", "POST /choosers/" + p.id
					+ " {select: [option indexes to add], deselect: [alreadySelected indexes to remove]} or {cancel: true}");
			return new Reply(202, body);
		}
		if (event instanceof RecordingUIDelegate.EditDone edit)
		{
			// A builder edit ended; the operation itself stays parked in the builder.
			if (edit.error() instanceof Exception e)
			{
				throw e;
			}
			if (edit.error() != null)
			{
				throw new RuntimeException(edit.error());
			}
			return edit.result();
		}
		Done done = (Done) event;
		synchronized (this)
		{
			if (current == op)
			{
				current = null;
			}
			notifyAll();
		}
		if (done.error() instanceof Exception e)
		{
			throw e;
		}
		if (done.error() != null)
		{
			throw new RuntimeException(done.error());
		}
		return done.result();
	}

	private Object answerChooser(String id, Request q) throws Exception
	{
		Operation op;
		synchronized (this)
		{
			op = current;
		}
		RecordingUIDelegate.PendingChooser p = op == null ? null : op.pending;
		if (p == null || !p.id.equals(id))
		{
			throw new ApiException(404, "no pending chooser " + id);
		}
		if (q.bool("cancel", false))
		{
			p.answer.complete(null);
		}
		else
		{
			try
			{
				p.answer.complete(new RecordingUIDelegate.Answer(indexes(q, "select"), indexes(q, "deselect")));
			}
			catch (NumberFormatException e)
			{
				throw new ApiException(400, "select and deselect must be integers");
			}
		}
		return awaitEvent(op);
	}

	private Object answerConfirm(String id, Request q) throws Exception
	{
		Operation op;
		synchronized (this)
		{
			op = current;
		}
		RecordingUIDelegate.PendingConfirm k = op == null ? null : op.confirm;
		if (k == null || !k.id.equals(id))
		{
			throw new ApiException(404, "no pending question " + id);
		}
		k.answer.complete(q.bool("ok", false));
		return awaitEvent(op);
	}

	private static int[] indexes(Request q, String name)
	{
		return q.strList(name).stream().mapToInt(Integer::parseInt).toArray();
	}

	private Map<String, Object> health()
	{
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("status", "ok");
		m.put("gameMode", session.gameMode.getName());
		m.put("sources", session.campaignNames());
		m.put("characters", session.characterIds());
		RecordingUIDelegate.PendingChooser p;
		synchronized (this)
		{
			p = current == null ? null : current.pending;
		}
		m.put("pendingChooser", p == null ? null : p.id);
		RecordingUIDelegate.PendingBuilder pb;
		synchronized (this)
		{
			pb = current == null ? null : current.builder;
		}
		m.put("pendingBuilder", pb == null ? null : pb.id);
		RecordingUIDelegate.PendingConfirm pk;
		synchronized (this)
		{
			pk = current == null ? null : current.confirm;
		}
		m.put("pendingConfirm", pk == null ? null : pk.id);
		m.put("pdfWarmup", pdfWarmup);
		m.put("uptimeSeconds", (System.currentTimeMillis() - startedAt) / 1000);
		return m;
	}
}
