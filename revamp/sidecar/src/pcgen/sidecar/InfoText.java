package pcgen.sidecar;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Turns the engine's info text into plain structured data. PCGen builds each info panel as a small HTML
 * document: {@code <b>Label:</b>&nbsp;value<br>} repeated, sometimes several labels per line (a spell's
 * Range and Target). Clients should not have to render that.
 */
final class InfoText
{
	private static final Pattern LABEL = Pattern.compile("<b>([^<]+?):\\s*</b>");

	/** PCGen marks requirements the character fails in red. */
	private static final String RED = "color=\"#ff0000\"";

	private InfoText()
	{
	}

	/** One {@code label}/{@code text} pair per labelled value, in the order the engine wrote them. */
	static List<Map<String, String>> sections(String html)
	{
		List<Map<String, String>> out = new ArrayList<>();
		if (html == null || html.isBlank())
		{
			return out;
		}
		String body = html.replaceAll("(?i)<b><font[^>]*>.*?</font></b>", "");
		Matcher m = LABEL.matcher(body);
		List<int[]> marks = new ArrayList<>();
		List<String> labels = new ArrayList<>();
		while (m.find())
		{
			marks.add(new int[] {m.start(), m.end()});
			labels.add(plain(m.group(1)));
		}
		for (int i = 0; i < marks.size(); i++)
		{
			int from = marks.get(i)[1];
			int to = i + 1 < marks.size() ? marks.get(i + 1)[0] : body.length();
			String text = plain(body.substring(from, to));
			if (text.isEmpty())
			{
				continue;
			}
			Map<String, String> sec = new LinkedHashMap<>();
			sec.put("label", labels.get(i));
			sec.put("text", text);
			out.add(sec);
		}
		return out;
	}

	/** True if the engine flagged part of the requirements as not met. */
	static boolean hasUnmetRequirement(String html)
	{
		return html != null && html.contains(RED);
	}

	/** Strips markup and entities. Paragraph breaks ({@code <br>}) survive as newlines. */
	static String plain(String html)
	{
		String t = html.replaceAll("(?i)<br\\s*/?>", "\n").replaceAll("<[^>]+>", "").replace("&nbsp;", " ")
				.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&amp;", "&");
		t = t.replaceAll("[ \\t\\x0B\\f\\r]+", " ").replaceAll(" ?\\n ?", "\n").replaceAll("\\n{3,}", "\n\n");
		return t.strip();
	}
}
