package pcgen.sidecar;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import pcgen.core.PlayerCharacter;
import pcgen.facade.core.CharacterFacade;
import pcgen.gui2.facade.SidecarAccess;
import pcgen.system.BatchExporter;

/**
 * Inputs for the attack calculator: what the engine itself says each of the character's weapons does (to-hit by attack,
 * damage dice, the damage bonus when held one-handed, two-handed or in the off hand, critical range, light or not).
 * They come from the same weapon figures the character sheet prints, so everything the engine knows (ability scores,
 * enchantment, Weapon Focus, Finesse damage choices...) is already in them. The calculator itself, which applies
 * Power Attack, two-weapon fighting and so on on top, runs in the browser.
 */
final class AttackRoutes
{
	private static final String SEP = "@@";

	/** One line per weapon with the figures the engine prints on the sheet (the generic sheet and this use the same tokens). */
	private static final String TEMPLATE = String.join("\n",
		"<@loop from=0 to=pcvar('COUNT[EQTYPE.WEAPON]-1') ; weap , weap_has_next>",
		"W@@${weap}@@${pcstring('WEAPON.${weap}.NAME')}@@${pcstring('WEAPON.${weap}.LONGNAME')}@@${pcstring('WEAPON.${weap}.CATEGORY')}"
			+ "@@${pcstring('WEAPON.${weap}.HAND')}@@${pcstring('WEAPON.${weap}.ISLIGHT')}@@${pcstring('WEAPON.${weap}.CRIT')}"
			+ "@@${pcstring('WEAPON.${weap}.MULT')}@@${pcstring('WEAPON.${weap}.SIZE')}@@${pcstring('WEAPON.${weap}.REACH')}"
			+ "@@${pcstring('WEAPON.${weap}.BASEHIT')}@@${pcstring('WEAPON.${weap}.NUMATTACKS')}@@${pcstring('WEAPON.${weap}.DAMAGE')}"
			+ "@@${pcstring('WEAPON.${weap}.BASICDAMAGE')}@@${pcstring('WEAPON.${weap}.THDAMAGE')}@@${pcstring('WEAPON.${weap}.OHDAMAGE')}"
			+ "@@${pcstring('WEAPON.${weap}.DAMAGEBONUS')}@@${pcstring('WEAPON.${weap}.THDAMAGEBONUS')}@@${pcstring('WEAPON.${weap}.OHDAMAGEBONUS')}"
			+ "@@${pcstring('WEAPON.${weap}.TYPE')}@@${pcstring('WEAPON.${weap}.TOTALHIT')}@@${pcstring('WEAPON.${weap}.THHIT')}"
			+ "@@${pcstring('WEAPON.${weap}.OHHIT')}@@${pcstring('WEAPON.${weap}.RANGE')}@@${pcstring('WEAPON.${weap}.HEFT')}",
		"</@loop>", "");

	private final Session s;

	AttackRoutes(Session s)
	{
		this.s = s;
	}

	void register(Router r)
	{
		r.get("/characters/{id}/attacks", this::attacks);
	}

	private Object attacks(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		String raw = render(c);
		if (q.bool("raw", false))
		{
			return new ExportRoutes.Binary("text/plain; charset=utf-8", raw.getBytes(StandardCharsets.UTF_8));
		}
		List<Map<String, Object>> weapons = new ArrayList<>();
		for (String line : raw.split("\\R"))
		{
			if (!line.startsWith("W" + SEP))
			{
				continue;
			}
			String[] f = line.split(SEP, -1);
			if (f.length < 26)
			{
				continue;
			}
			weapons.add(weapon(f));
		}
		PlayerCharacter pc = SidecarAccess.playerCharacter(c);
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("bab", pc.baseAttackBonus());
		m.put("weapons", weapons);
		return m;
	}

	/** One weapon line of the template as the figures the calculator needs. */
	private static Map<String, Object> weapon(String[] f)
	{
		Map<String, Object> w = new LinkedHashMap<>();
		w.put("index", Integer.parseInt(f[1].trim()));
		w.put("name", f[2]);
		w.put("longName", f[3]);
		String category = f[4];
		w.put("category", category);
		w.put("melee", category.contains("Melee"));
		w.put("ranged", category.contains("Ranged") && !category.contains("Melee"));
		w.put("natural", category.startsWith("Natural"));
		w.put("hand", f[5]);
		w.put("light", "TRUE".equalsIgnoreCase(f[6].trim()));
		w.put("critRange", f[7].trim());
		w.put("critMult", number(f[8]));
		w.put("size", f[9]);
		w.put("reach", f[10]);
		// To hit with every attack the character gets, before two-weapon penalties and the like. A two-handed weapon has no
		// one-handed figure ("N/A"), so use its two-handed one.
		List<Integer> hits = hits(f[11]);
		boolean twoHanded = hits.isEmpty() && w.get("melee") == Boolean.TRUE;
		if (hits.isEmpty())
		{
			hits = hits(f[22]);
		}
		w.put("twoHanded", twoHanded);
		w.put("baseHit", hits);
		w.put("dice", dice(f[13]));
		Map<String, Object> bonus = new LinkedHashMap<>();
		bonus.put("oneHand", damageBonus(f[14]));
		bonus.put("twoHand", damageBonus(f[15]));
		bonus.put("offHand", damageBonus(f[16]));
		w.put("damageBonus", bonus);
		w.put("type", f[20]);
		return w;
	}

	private static Integer number(String s)
	{
		try
		{
			return Integer.valueOf(s.trim().replace("+", ""));
		}
		catch (NumberFormatException e)
		{
			return null;
		}
	}

	/** "+21/+16" -> [21, 16]; anything that is not a list of numbers (the sheet prints "N/A") -> []. */
	static List<Integer> hits(String s)
	{
		List<Integer> out = new ArrayList<>();
		for (String part : s.trim().split("/"))
		{
			Integer n = number(part);
			if (n == null)
			{
				return List.of();
			}
			out.add(n);
		}
		return out;
	}

	/** The dice of a damage figure such as "1d4+10", "2d6-1" or "1d6/1d6" (a double weapon: its first end). */
	static String dice(String s)
	{
		java.util.regex.Matcher m = java.util.regex.Pattern.compile("(\\d+d\\d+)").matcher(s);
		return m.find() ? m.group(1) : null;
	}

	/** The flat part of a damage figure: "1d4+10" -> 10, "1d4-1" -> -1, "1d4" -> 0, "N/A" -> null. */
	static Integer damageBonus(String s)
	{
		java.util.regex.Matcher m = java.util.regex.Pattern.compile("^\\s*\\d+d\\d+\\s*([+-]\\s*\\d+)?").matcher(s);
		if (!m.find())
		{
			return null;
		}
		return m.group(1) == null ? Integer.valueOf(0) : Integer.valueOf(m.group(1).replace(" ", "").replace("+", ""));
	}

	/** Runs the little template above for the character and returns what it printed. */
	private String render(CharacterFacade c)
	{
		File template = null;
		File out = null;
		try
		{
			template = File.createTempFile("pcgen-attacks-", ".ftl");
			Files.writeString(template.toPath(), TEMPLATE, StandardCharsets.UTF_8);
			out = File.createTempFile("pcgen-attacks-", ".out");
			if (!BatchExporter.exportCharacterToNonPDF(c, out, template))
			{
				throw new ApiException(500, "could not read the weapon figures: " + s.ui.drain());
			}
			return Files.readString(out.toPath(), StandardCharsets.UTF_8);
		}
		catch (IOException e)
		{
			throw new ApiException(500, "could not read the weapon figures: " + e);
		}
		finally
		{
			if (template != null)
			{
				template.delete();
			}
			if (out != null)
			{
				out.delete();
			}
		}
	}
}
