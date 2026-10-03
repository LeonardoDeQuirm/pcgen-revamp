package pcgen.sidecar;

import java.util.List;
import java.util.Map;


/**
 * A parsed API request. Handlers read arguments with the typed accessors, which look in the
 * JSON body first and then the query string, so simple calls can stay in the URL.
 *
 * @param params path parameters, e.g. {@code id} from {@code /characters/{id}}
 * @param body   parsed JSON body, empty if there was none
 */
record Request(String method, String path, Map<String, String> params, Map<String, String> query,
		Map<String, Object> body)
{
	String param(String name)
	{
		return params.get(name);
	}

	/** Raw argument from the body (any JSON type) or query (String), or null. */
	Object get(String name)
	{
		return body.containsKey(name) ? body.get(name) : query.get(name);
	}

	boolean has(String name)
	{
		return body.containsKey(name) || query.containsKey(name);
	}

	String str(String name)
	{
		Object v = get(name);
		return v == null ? null : v.toString();
	}

	String requireStr(String name)
	{
		String v = str(name);
		if (v == null || v.isBlank())
		{
			throw new ApiException(400, "missing argument: " + name);
		}
		return v;
	}

	Integer integer(String name)
	{
		Object v = get(name);
		if (v == null)
		{
			return null;
		}
		if (v instanceof Number n)
		{
			return n.intValue();
		}
		try
		{
			return Integer.parseInt(v.toString().trim());
		}
		catch (NumberFormatException e)
		{
			throw new ApiException(400, "argument " + name + " must be an integer");
		}
	}

	int requireInt(String name)
	{
		Integer v = integer(name);
		if (v == null)
		{
			throw new ApiException(400, "missing argument: " + name);
		}
		return v;
	}

	boolean bool(String name, boolean dflt)
	{
		Object v = get(name);
		if (v == null)
		{
			return dflt;
		}
		if (v instanceof Boolean b)
		{
			return b;
		}
		String t = v.toString().trim().toLowerCase();
		return t.equals("true") || t.equals("1") || t.equals("yes");
	}

	/** A list argument: a JSON array, or a comma-separated string. */
	List<String> strList(String name)
	{
		Object v = get(name);
		if (v == null)
		{
			return List.of();
		}
		if (v instanceof List<?> l)
		{
			return l.stream().map(String::valueOf).toList();
		}
		String t = v.toString().trim();
		return t.isEmpty() ? List.of() : java.util.Arrays.stream(t.split(",")).map(String::trim).toList();
	}
}
