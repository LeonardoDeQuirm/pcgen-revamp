package pcgen.sidecar;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import pcgen.core.Deity;
import pcgen.core.PCClass;
import pcgen.core.PCTemplate;
import pcgen.core.Race;
import pcgen.core.Skill;
import pcgen.facade.core.CharacterFacade;
import pcgen.facade.core.EquipmentFacade;
import pcgen.facade.core.InfoFactory;

/**
 * The full description of one catalog entry (a race, class, skill, deity, template or piece of equipment),
 * in the same shape as the ability and spell descriptions so the UI's side panel can show any of them.
 * Needs a character only because the engine's description writer belongs to one.
 */
final class InfoRoutes
{
	private final Session s;

	InfoRoutes(Session s)
	{
		this.s = s;
	}

	void register(Router r)
	{
		r.get("/characters/{id}/info", this::info);
	}

	/**
	 * What a race gives you: its default racial traits (the +2/-2 ability changes, size, speed, darkvision...), each
	 * with the data's own one-line description. The data marks them with the type "<Race> Racial Default".
	 */
	private List<Map<String, String>> racialTraits(CharacterFacade c, Race race)
	{
		List<Map<String, String>> out = new java.util.ArrayList<>();
		// "Special Ability" is not one of the categories a player picks from, so it is not in the facade's list.
		var ref = pcgen.core.Globals.getContext().getReferenceContext();
		pcgen.core.AbilityCategory special = ref.silentlyGetConstructedCDOMObject(pcgen.core.AbilityCategory.class,
				"Special Ability");
		if (special == null)
		{
			return out;
		}
		String marker = race.getKeyName() + " Racial Default";
		InfoFactory f = c.getInfoFactory();
		for (pcgen.core.Ability a : ref.getManufacturerId(special).getAllObjects())
		{
			if (!a.isType(marker))
			{
				continue;
			}
			String text = f.getDescription(a);
			if (text == null || text.isBlank())
			{
				continue;
			}
			Map<String, String> sec = new LinkedHashMap<>();
			sec.put("label", a.getDisplayName());
			// Amounts that depend on the race (a dodge bonus "+4", a Perception "+2") read "+0" here, because the
			// character is not that race yet; leave the number out rather than show a wrong one.
			sec.put("text", InfoText.plain(text).replaceAll("\\+0 (?=[A-Za-z])", ""));
			out.add(sec);
		}
		// The ability-score line first: it is why most people pick a race.
		out.sort(java.util.Comparator.comparing((Map<String, String> m) -> !m.get("label").matches("^[+-]\\d.*")));
		return out;
	}

	private Object info(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		InfoFactory f = c.getInfoFactory();
		String kind = q.requireStr("kind");
		String name = q.requireStr("name");
		var data = c.getDataSet();
		String key;
		String display;
		String type = null;
		String source = null;
		String html;
		Boolean classQualified = null;
		List<String> classUnmet = List.of();
		switch (kind)
		{
			case "race" -> {
				Race o = Lookup.pObject(data.getRaces(), name, "race");
				key = o.getKeyName();
				display = o.getDisplayName();
				html = f.getHTMLInfo(o);
			}
			case "class" -> {
				PCClass o = Lookup.pObject(data.getClasses(), name, "class");
				key = o.getKeyName();
				display = o.getDisplayName();
				html = f.getHTMLInfo(o, null);
				classQualified = c.isQualifiedFor(o);
				classUnmet = Requirements.unmet(html);
			}
			case "skill" -> {
				Skill o = Lookup.pObject(data.getSkills(), name, "skill");
				key = o.getKeyName();
				display = o.getDisplayName();
				html = f.getHTMLInfo(o);
			}
			case "deity" -> {
				Deity o = Lookup.pObject(data.getDeities(), name, "deity");
				key = o.getKeyName();
				display = o.getDisplayName();
				html = f.getHTMLInfo(o);
			}
			case "template" -> {
				PCTemplate o = Lookup.pObject(data.getTemplates(), name, "template");
				key = o.getKeyName();
				display = o.getDisplayName();
				html = f.getHTMLInfo(o);
			}
			case "equipment" -> {
				EquipmentFacade o;
				try
				{
					o = Lookup.find(data.getEquipment(), name, "equipment", EquipmentFacade::getKeyName, Object::toString);
				}
				catch (ApiException notInShop)
				{
					// Customised or made-up items exist only on the character.
					o = Lookup.find(c.getPurchasedEquipment(), name, "equipment", EquipmentFacade::getKeyName,
							Object::toString);
				}
				key = o.getKeyName();
				display = o.toString();
				type = o.getType();
				source = o.getSource();
				html = f.getHTMLInfo(o);
			}
			default -> throw new ApiException(400,
					"kind must be race, class, skill, deity, template or equipment");
		}
		List<Map<String, String>> sections = InfoText.sections(html);
		if (kind.equals("skill"))
		{
			// The data marks every ordinary skill "AnimalCompanionSkill less than 1" (a rule for companions); it
			// means nothing to a player.
			sections = new java.util.ArrayList<>(sections);
			sections.removeIf(sec -> "Requirements".equals(sec.get("label"))
					&& sec.get("text").startsWith("AnimalCompanionSkill"));
		}
		if (kind.equals("race"))
		{
			// The engine's race text leaves out the things a player picks a race for, and has an internal flag.
			sections = new java.util.ArrayList<>(sections);
			sections.removeIf(sec -> "IsPC".equals(sec.get("label")));
			Race race = Lookup.pObject(data.getRaces(), name, "race");
			int at = 0;
			for (String[] extra : new String[][] {{"Ability modifiers", f.getStatAdjustments(race)},
				{"Favored class", f.getFavoredClass(race)}, {"Vision", f.getVision(race)}})
			{
				String text = extra[1] == null ? "" : InfoText.plain(extra[1]);
				if (!text.isBlank() && sections.stream().noneMatch(sec -> extra[0].equals(sec.get("label"))))
				{
					Map<String, String> sec = new LinkedHashMap<>();
					sec.put("label", extra[0]);
					sec.put("text", text);
					sections.add(Math.min(at++, sections.size()), sec);
				}
			}
		}
		if (kind.equals("race"))
		{
			Race race = Lookup.pObject(data.getRaces(), name, "race");
			sections = new java.util.ArrayList<>(sections);
			sections.addAll(0, racialTraits(c, race));
		}
		Map<String, Object> m = new LinkedHashMap<>();
		if (classQualified != null)
		{
			m.put("qualified", classQualified);
			if (!classQualified)
			{
				m.put("unmet", classUnmet);
				m.put("reason", classUnmet.isEmpty() ? "This character does not meet the requirements for this class."
						: Requirements.sentence(classUnmet));
			}
		}
		m.put("key", key);
		m.put("name", display);
		m.put("kind", kind);
		m.put("type", type);
		m.put("source", source);
		m.put("sections", sections);
		return m;
	}
}
