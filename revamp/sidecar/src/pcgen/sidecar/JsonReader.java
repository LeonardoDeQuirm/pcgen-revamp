package pcgen.sidecar;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal JSON parser for request bodies. Objects become {@code Map<String,Object>}, arrays
 * {@code List<Object>}, numbers {@code Long} (if integral) or {@code Double}, plus String,
 * Boolean and null.
 */
final class JsonReader
{
	private final String s;
	private int i;

	private JsonReader(String s)
	{
		this.s = s;
	}

	static Object parse(String text)
	{
		JsonReader r = new JsonReader(text);
		r.ws();
		Object v = r.value();
		r.ws();
		if (r.i != r.s.length())
		{
			throw r.error("unexpected trailing content");
		}
		return v;
	}

	private IllegalArgumentException error(String msg)
	{
		return new IllegalArgumentException("invalid JSON at position " + i + ": " + msg);
	}

	private void ws()
	{
		while (i < s.length() && Character.isWhitespace(s.charAt(i)))
		{
			i++;
		}
	}

	private char peek()
	{
		if (i >= s.length())
		{
			throw error("unexpected end of input");
		}
		return s.charAt(i);
	}

	private void expect(char c)
	{
		if (peek() != c)
		{
			throw error("expected '" + c + "'");
		}
		i++;
	}

	private Object value()
	{
		char c = peek();
		switch (c)
		{
			case '{':
				return object();
			case '[':
				return array();
			case '"':
				return string();
			case 't':
				literal("true");
				return Boolean.TRUE;
			case 'f':
				literal("false");
				return Boolean.FALSE;
			case 'n':
				literal("null");
				return null;
			default:
				return number();
		}
	}

	private void literal(String word)
	{
		if (!s.startsWith(word, i))
		{
			throw error("expected " + word);
		}
		i += word.length();
	}

	private Map<String, Object> object()
	{
		Map<String, Object> m = new LinkedHashMap<>();
		expect('{');
		ws();
		if (peek() == '}')
		{
			i++;
			return m;
		}
		while (true)
		{
			ws();
			String k = string();
			ws();
			expect(':');
			ws();
			m.put(k, value());
			ws();
			if (peek() == ',')
			{
				i++;
				continue;
			}
			expect('}');
			return m;
		}
	}

	private List<Object> array()
	{
		List<Object> l = new ArrayList<>();
		expect('[');
		ws();
		if (peek() == ']')
		{
			i++;
			return l;
		}
		while (true)
		{
			ws();
			l.add(value());
			ws();
			if (peek() == ',')
			{
				i++;
				continue;
			}
			expect(']');
			return l;
		}
	}

	private String string()
	{
		expect('"');
		StringBuilder sb = new StringBuilder();
		while (true)
		{
			char c = peek();
			i++;
			if (c == '"')
			{
				return sb.toString();
			}
			if (c != '\\')
			{
				sb.append(c);
				continue;
			}
			char e = peek();
			i++;
			switch (e)
			{
				case '"', '\\', '/' -> sb.append(e);
				case 'n' -> sb.append('\n');
				case 'r' -> sb.append('\r');
				case 't' -> sb.append('\t');
				case 'b' -> sb.append('\b');
				case 'f' -> sb.append('\f');
				case 'u' ->
				{
					if (i + 4 > s.length())
					{
						throw error("bad \\u escape");
					}
					sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
					i += 4;
				}
				default -> throw error("bad escape \\" + e);
			}
		}
	}

	private Object number()
	{
		int start = i;
		while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0)
		{
			i++;
		}
		String t = s.substring(start, i);
		if (t.isEmpty())
		{
			throw error("unexpected character '" + peek() + "'");
		}
		try
		{
			if (t.matches("-?\\d+"))
			{
				return Long.parseLong(t);
			}
			return Double.parseDouble(t);
		}
		catch (NumberFormatException e)
		{
			throw error("bad number " + t);
		}
	}
}
