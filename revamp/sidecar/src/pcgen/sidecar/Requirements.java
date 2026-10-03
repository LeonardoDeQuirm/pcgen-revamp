package pcgen.sidecar;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Says in plain words which requirement a character fails. The engine marks the unmet part of a requirement
 * in red inside its info text, in its own notation ("IsHalfOrc=true", "at least 1 levels of Inquisitor",
 * "var: PreStatScore_STR at least 13"). This pulls those pieces out and rewords the ones we recognise; the
 * rest are passed through tidied up, which is still better than "requirements not met".
 */
final class Requirements
{
	private static final Pattern RED = Pattern.compile("<font color=\"#ff0000\">(.*?)</font>", Pattern.DOTALL);

	private static final Map<String, String> STATS = Map.of("STR", "Strength", "DEX", "Dexterity", "CON", "Constitution",
			"INT", "Intelligence", "WIS", "Wisdom", "CHA", "Charisma");

	private Requirements()
	{
	}

	/** The unmet requirements, reworded. Empty if the engine flagged nothing. */
	static List<String> unmet(String html)
	{
		List<String> out = new ArrayList<>();
		if (html == null)
		{
			return out;
		}
		Matcher m = RED.matcher(html);
		while (m.find())
		{
			String text = InfoText.plain(m.group(1));
			if (!text.isEmpty())
			{
				String said = say(text);
				if (!out.contains(said))
				{
					out.add(said);
				}
			}
		}
		return out;
	}

	/** Rewords one requirement fragment. */
	static String say(String raw)
	{
		String t = raw.strip();
		Matcher m;

		// Race / identity flags: IsHalfOrc=true
		m = Pattern.compile("^Is(\\w+)=true$").matcher(t);
		if (m.matches())
		{
			return "must be a " + words(m.group(1));
		}
		m = Pattern.compile("^Is(\\w+)=false$").matcher(t);
		if (m.matches())
		{
			return "must not be a " + words(m.group(1));
		}
		// Ability scores
		m = Pattern.compile("^var: PreStatScore_(\\w+) at least (\\d+)$").matcher(t);
		if (m.matches())
		{
			return (STATS.getOrDefault(m.group(1), m.group(1))) + " " + m.group(2) + " or higher";
		}
		// Class levels
		m = Pattern.compile("^at least (\\d+) levels? of ([\\w' -]+)$").matcher(t);
		if (m.matches())
		{
			return "needs " + m.group(1) + " level" + ("1".equals(m.group(1)) ? "" : "s") + " of " + m.group(2);
		}
		// Base attack bonus
		m = Pattern.compile("^Base Attack at least (\\d+)$").matcher(t);
		if (m.matches())
		{
			return "needs a base attack bonus of +" + m.group(1) + " or higher";
		}
		// Having another ability: "at least 1 Inquisitor Special Ability" / "at least 1 Power Attack Feat"
		m = Pattern.compile("^(?:all of \\( )?at least (\\d+) ([\\w' ~()/&-]+?) (?:Special Ability|Feat)(?: \\))?$").matcher(t);
		if (m.matches())
		{
			String what = m.group(2).replaceFirst("^[A-Za-z ]+ ~ ", "");
			return "needs " + what;
		}
		// Not having something: "none of ( at least 1 TYPE.CombatTrait Special Ability )"
		m = Pattern.compile("none of \\( at least \\d+ TYPE\\.(\\w+)").matcher(t);
		if (m.find())
		{
			return "only one " + words(m.group(1)) + " is allowed";
		}
		// Anything else: the engine's own wording, minus its variable prefixes.
		return t.replace("var: ", "").replaceAll("\\s+", " ");
	}

	/** "HalfOrc" -> "Half Orc". */
	private static String words(String camel)
	{
		return camel.replaceAll("(?<=[a-z])(?=[A-Z])", " ");
	}

	/** One sentence for a notice: "Not met: must be a Half Orc; needs Inquisitor." */
	static String sentence(List<String> unmet)
	{
		if (unmet.isEmpty())
		{
			return "This character doesn't meet the requirements.";
		}
		String joined = String.join("; ", unmet);
		return "Requirement not met: " + joined + ".";
	}
}
