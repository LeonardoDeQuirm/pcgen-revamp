package pcgen.sidecar;

import java.io.File;
import java.io.IOException;
import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Stream;

import pcgen.facade.core.CharacterFacade;
import pcgen.core.SettingsHandler;
import pcgen.io.ExportUtilities;
import pcgen.io.ExportUtilities.SheetFilter;
import pcgen.system.CharacterManager;
import pcgen.util.Logging;
import pcgen.system.BatchExporter;
import pcgen.system.ConfigurationSettings;

/**
 * Character sheet output. PDF is produced by the engine's FOP pipeline from an XSLT/FO template;
 * everything else (text, HTML, XML) from the other templates. The response body is the file itself.
 */
final class ExportRoutes
{
	private final Session s;

	ExportRoutes(Session s)
	{
		this.s = s;
	}

	void register(Router r)
	{
		r.get("/templates", q -> templates(null, q));
		r.get("/characters/{id}/templates", q -> templates(s.character(q.param("id")), q));
		r.post("/characters/{id}/export", this::export);
	}

	/**
	 * Renders a throwaway PDF so the first real one doesn't pay for FOP, XSLT and font start-up
	 * (3-8 s). Runs on the engine thread; failures only cost the warm-up.
	 */
	static void warmUp(Session s)
	{
		long t0 = System.nanoTime();
		CharacterFacade temp = null;
		File out = null;
		try
		{
			temp = CharacterManager.createNewCharacter(s.ui, s.dataSet());
			if (temp == null)
			{
				return;
			}
			ExportRoutes r = new ExportRoutes(s);
			String sheet = r.defaultSheet(temp, SheetFilter.PDF);
			if (sheet == null)
			{
				Logging.log(Logging.INFO, "PDF warm-up skipped: no default PDF sheet for this game mode");
				return;
			}
			out = File.createTempFile("pcgen-warmup-", ".pdf");
			BatchExporter.exportCharacterToPDF(temp, out, r.resolve(sheet));
			Logging.log(Logging.INFO, "PDF warm-up done in " + (System.nanoTime() - t0) / 1_000_000 + " ms");
		}
		catch (Throwable t)
		{
			Logging.log(Logging.WARNING, "PDF warm-up failed (harmless): " + t);
		}
		finally
		{
			if (temp != null)
			{
				CharacterManager.removeCharacter(temp);
			}
			if (out != null)
			{
				out.delete();
			}
			s.ui.drain();
		}
	}

	/** A response that is a file rather than JSON. */
	record Binary(String contentType, byte[] bytes)
	{
	}

	private Path sheetsDir()
	{
		return Path.of(ConfigurationSettings.getOutputSheetsDir()).toAbsolutePath().normalize();
	}

	/**
	 * Accepts an absolute path or one relative to the output sheets folder, but only files that really live inside
	 * that folder (after resolving "..", symlinks and the like). Otherwise this would be a way to read any file on
	 * the machine through the text exporter.
	 */
	private File resolve(String template)
	{
		Path root = sheetsDir();
		Path wanted;
		try
		{
			Path given = Path.of(template);
			wanted = (given.isAbsolute() ? given : root.resolve(given)).toAbsolutePath().normalize();
		}
		catch (java.nio.file.InvalidPathException e)
		{
			throw new ApiException(400, "not a valid template path: " + template);
		}
		Path real;
		Path realRoot;
		try
		{
			realRoot = root.toRealPath();
			real = wanted.toRealPath();
		}
		catch (IOException e)
		{
			throw new ApiException(404, "no such template: " + template + " (see GET /templates)");
		}
		if (!real.startsWith(realRoot))
		{
			throw new ApiException(403, "templates must be inside the output sheets folder");
		}
		if (!Files.isRegularFile(real))
		{
			throw new ApiException(404, "no such template: " + template + " (see GET /templates)");
		}
		return real.toFile();
	}

	/**
	 * The sheet the engine would use by default for this format: the character's remembered choice,
	 * else the game mode's standard sheet. Relative to the output sheets folder; null if there is none.
	 */
	private String defaultSheet(CharacterFacade c, SheetFilter filter)
	{
		try
		{
			Path dir = sheetsDir();
			String modeDir = SettingsHandler.getGameAsProperty().get().getOutputSheetDirectory();
			if (modeDir != null)
			{
				dir = dir.resolve(modeDir);
			}
			dir = dir.resolve(filter.getPath());
			URI rel = ExportUtilities.getDefaultSheet(filter, c);
			Path full = rel.isAbsolute() ? Path.of(rel) : dir.resolve(URLDecoder.decode(rel.getPath(), StandardCharsets.UTF_8));
			if (!Files.isRegularFile(full))
			{
				return null;
			}
			full = full.toAbsolutePath().normalize();
			return full.startsWith(sheetsDir()) ? sheetsDir().relativize(full).toString().replace('\\', '/') : full.toString();
		}
		catch (RuntimeException e)
		{
			return null;
		}
	}

	private static SheetFilter filterFor(String format)
	{
		return switch (format.toLowerCase(Locale.ROOT))
		{
			case "pdf" -> SheetFilter.PDF;
			case "text", "txt" -> SheetFilter.TEXT;
			case "html", "htm", "xml" -> SheetFilter.HTMLXML;
			default -> throw new ApiException(400, "format must be pdf, text or html");
		};
	}

	private static String kind(String name)
	{
		if (ExportUtilities.isPdfTemplate(name))
		{
			return "pdf";
		}
		String n = name.toLowerCase(Locale.ROOT);
		if (n.endsWith(".htm") || n.endsWith(".html") || n.contains(".htm."))
		{
			return "html";
		}
		if (n.endsWith(".xml") || n.contains(".xml."))
		{
			return "xml";
		}
		return "text";
	}

	/** Lists output templates, optionally filtered by {@code kind} (pdf, text, html, xml) and {@code q}. */
	private Object templates(CharacterFacade c, Request q)
	{
		String wantKind = q.str("kind");
		String needle = q.str("q") == null ? "" : q.str("q").toLowerCase(Locale.ROOT);
		Path root = sheetsDir();
		int limit = q.integer("limit") == null ? 200 : q.requireInt("limit");
		List<Map<String, Object>> out = new ArrayList<>();
		int total = 0;
		try (Stream<Path> walk = Files.walk(root))
		{
			List<Path> files = walk.filter(Files::isRegularFile).sorted(Comparator.comparing(Path::toString)).toList();
			for (Path p : files)
			{
				String rel = root.relativize(p).toString().replace('\\', '/');
				String name = p.getFileName().toString();
				// Only top-level sheets: skip includes/fonts/support files.
				if (rel.contains("/common") || rel.contains("fonts/") || rel.contains("xsltsl") || name.startsWith("fantasy_master")
						|| name.startsWith("inc_") || name.endsWith(".xconf") || name.endsWith(".png") || name.endsWith(".jpg")
						|| name.endsWith(".gif") || name.endsWith(".ttf") || name.endsWith(".css") || name.endsWith(".js"))
				{
					continue;
				}
				String k = kind(name);
				if ((wantKind != null && !wantKind.equalsIgnoreCase(k)) || !rel.toLowerCase(Locale.ROOT).contains(needle))
				{
					continue;
				}
				total++;
				if (out.size() < limit)
				{
					out.add(Map.of("template", rel, "kind", k));
				}
			}
		}
		catch (IOException e)
		{
			throw new ApiException(500, "cannot read output sheets: " + e);
		}
		Map<String, Object> m = new LinkedHashMap<>();
		if (c != null)
		{
			m.put("defaultPdf", defaultSheet(c, SheetFilter.PDF));
			m.put("defaultHtml", defaultSheet(c, SheetFilter.HTMLXML));
			m.put("defaultText", defaultSheet(c, SheetFilter.TEXT));
		}
		m.put("total", total);
		m.put("items", out);
		return m;
	}

	/**
	 * Body or query: {@code template} (path, absolute or relative to the output sheets folder).
	 * If omitted, {@code format} (pdf, text or html) selects the default sheet.
	 */
	private Object export(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		String template = q.str("template");
		if (template == null || template.isBlank())
		{
			String format = q.str("format");
			if (format == null)
			{
				throw new ApiException(400, "missing argument: template (or format=pdf|text for the default sheet)");
			}
			template = defaultSheet(c, filterFor(format));
			if (template == null || template.isBlank())
			{
				throw new ApiException(409, "this character has no default " + format + " sheet; pass template");
			}
		}
		File templateFile = resolve(template);
		boolean pdf = ExportUtilities.isPdfTemplate(templateFile);
		String suffix = pdf ? ".pdf" : ".out";
		File out = null;
		try
		{
			out = File.createTempFile("pcgen-sidecar-", suffix);
			boolean ok = pdf ? BatchExporter.exportCharacterToPDF(c, out, templateFile)
					: BatchExporter.exportCharacterToNonPDF(c, out, templateFile);
			if (!ok)
			{
				throw new ApiException(500, "export failed: " + s.ui.drain());
			}
			return new Binary(pdf ? "application/pdf" : "text/plain; charset=utf-8", Files.readAllBytes(out.toPath()));
		}
		catch (IOException e)
		{
			throw new ApiException(500, "export failed: " + e);
		}
		finally
		{
			if (out != null)
			{
				out.delete();
			}
		}
	}
}
