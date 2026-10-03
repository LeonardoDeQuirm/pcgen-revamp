package pcgen.sidecar;

import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.Map;

/** Minimal JSON writer; avoids adding a dependency for the skeleton. */
final class Json
{
	private Json()
	{
	}

	static String write(Object o)
	{
		StringBuilder sb = new StringBuilder();
		write(sb, o);
		return sb.toString();
	}

	private static void write(StringBuilder sb, Object o)
	{
		if (o == null)
		{
			sb.append("null");
		}
		else if (o instanceof Number || o instanceof Boolean)
		{
			sb.append(o);
		}
		else if (o instanceof Map<?, ?> m)
		{
			sb.append('{');
			boolean first = true;
			for (Map.Entry<?, ?> e : m.entrySet())
			{
				if (!first)
				{
					sb.append(',');
				}
				first = false;
				string(sb, String.valueOf(e.getKey()));
				sb.append(':');
				write(sb, e.getValue());
			}
			sb.append('}');
		}
		else if (o instanceof Collection<?> c)
		{
			sb.append('[');
			boolean first = true;
			for (Object x : c)
			{
				if (!first)
				{
					sb.append(',');
				}
				first = false;
				write(sb, x);
			}
			sb.append(']');
		}
		else if (o instanceof Record r)
		{
			Map<String, Object> m = new LinkedHashMap<>();
			for (var rc : r.getClass().getRecordComponents())
			{
				try
				{
					m.put(rc.getName(), rc.getAccessor().invoke(r));
				}
				catch (ReflectiveOperationException e)
				{
					throw new IllegalStateException(e);
				}
			}
			write(sb, m);
		}
		else
		{
			string(sb, o.toString());
		}
	}

	private static void string(StringBuilder sb, String s)
	{
		sb.append('"');
		for (int i = 0; i < s.length(); i++)
		{
			char c = s.charAt(i);
			switch (c)
			{
				case '"' -> sb.append("\\\"");
				case '\\' -> sb.append("\\\\");
				case '\n' -> sb.append("\\n");
				case '\r' -> sb.append("\\r");
				case '\t' -> sb.append("\\t");
				default ->
				{
					if (c < 0x20)
					{
						sb.append(String.format("\\u%04x", (int) c));
					}
					else
					{
						sb.append(c);
					}
				}
			}
		}
		sb.append('"');
	}
}
