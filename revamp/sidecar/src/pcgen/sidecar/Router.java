package pcgen.sidecar;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

/** Matches method + path patterns such as {@code /characters/{id}/skills} to handlers. */
final class Router
{
	@FunctionalInterface
	interface Handler
	{
		Object handle(Request request) throws Exception;
	}

	private record Route(String method, String[] pattern, Handler handler, String text)
	{
	}

	private final List<Route> routes = new ArrayList<>();

	void add(String method, String pattern, Handler handler)
	{
		routes.add(new Route(method, split(pattern), handler, method + " " + pattern));
	}

	void get(String pattern, Handler h)
	{
		add("GET", pattern, h);
	}

	void post(String pattern, Handler h)
	{
		add("POST", pattern, h);
	}

	void put(String pattern, Handler h)
	{
		add("PUT", pattern, h);
	}

	void patch(String pattern, Handler h)
	{
		add("PATCH", pattern, h);
	}

	void delete(String pattern, Handler h)
	{
		add("DELETE", pattern, h);
	}

	/** Human-readable route table, for {@code GET /routes}. */
	List<String> describe()
	{
		return routes.stream().map(Route::text).sorted().collect(Collectors.toList());
	}

	/** Result of matching: the handler and the path parameters, or null if nothing matched. */
	record Match(Handler handler, Map<String, String> params)
	{
	}

	Match match(String method, String path)
	{
		String[] seg = split(path);
		for (Route r : routes)
		{
			if (!r.method().equals(method) || r.pattern().length != seg.length)
			{
				continue;
			}
			Map<String, String> params = new LinkedHashMap<>();
			boolean ok = true;
			for (int i = 0; i < seg.length && ok; i++)
			{
				String p = r.pattern()[i];
				if (p.startsWith("{") && p.endsWith("}"))
				{
					params.put(p.substring(1, p.length() - 1), seg[i]);
				}
				else
				{
					ok = p.equals(seg[i]);
				}
			}
			if (ok)
			{
				return new Match(r.handler(), params);
			}
		}
		return null;
	}

	/** True if some route matches the path under a different method (so we can answer 405). */
	boolean pathExists(String path)
	{
		String[] seg = split(path);
		for (Route r : routes)
		{
			if (r.pattern().length != seg.length)
			{
				continue;
			}
			boolean ok = true;
			for (int i = 0; i < seg.length && ok; i++)
			{
				String p = r.pattern()[i];
				ok = (p.startsWith("{") && p.endsWith("}")) || p.equals(seg[i]);
			}
			if (ok)
			{
				return true;
			}
		}
		return false;
	}

	private static String[] split(String path)
	{
		String t = path.replaceAll("^/+|/+$", "");
		return t.isEmpty() ? new String[0] : t.split("/");
	}
}
