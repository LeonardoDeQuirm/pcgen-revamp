package pcgen.sidecar;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import pcgen.core.AbilityCategory;
import pcgen.gui2.facade.SidecarAccess;
import pcgen.facade.core.AbilityFacade;
import pcgen.facade.core.CharacterFacade;
import pcgen.facade.core.InfoFactory;

/** Feats and other abilities. Adding or removing may raise choosers (see the chooser bridge). */
final class AbilityRoutes
{
	private final Session s;
	private final CharacterRoutes characters;

	AbilityRoutes(Session s, CharacterRoutes characters)
	{
		this.s = s;
		this.characters = characters;
	}

	void register(Router r)
	{
		r.get("/characters/{id}/abilities", this::list);
		r.get("/characters/{id}/abilities/info", this::info);
		r.post("/characters/{id}/abilities", this::add);
		r.delete("/characters/{id}/abilities", this::remove);
		r.post("/characters/{id}/gm/bonus-feats", this::bonusFeats);
		r.post("/characters/{id}/gm/languages", this::gmLanguage);
		r.delete("/characters/{id}/gm/languages", this::gmLanguageRemove);
	}

	private AbilityCategory category(CharacterFacade c, String name)
	{
		return Lookup.find(c.getDataSet().getAbilities().getKeys(), name, "ability category",
				AbilityCategory::getKeyName, AbilityCategory::getDisplayName);
	}

	private Object list(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		return q.has("category")
				? Map.of("category", category(c, q.str("category")).getKeyName(),
						"abilities", CharacterView.names(c.getAbilities(category(c, q.str("category")))))
				: CharacterView.abilityCategories(c);
	}

	/**
	 * Everything the engine knows about what an ability does: its description, prerequisites, type and
	 * source, plus the ready-made HTML summary PCGen's own info panel shows. Works for abilities the
	 * character has and ones it could take (prerequisites are evaluated for this character).
	 */
	private Object info(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		AbilityCategory cat = category(c, q.requireStr("category"));
		AbilityFacade ability = Lookup.find(c.getDataSet().getAbilities().getValue(cat), q.requireStr("name"),
				"ability in " + cat.getKeyName(), AbilityFacade::getKeyName, Object::toString);
		InfoFactory info = c.getInfoFactory();
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("key", ability.getKeyName());
		m.put("name", CharacterView.text(ability));
		m.put("category", cat.getKeyName());
		m.put("type", ability.getType());
		m.put("source", ability.getSource());
		m.put("description", info.getDescription(ability));
		m.put("choices", info.getChoices(ability));
		String html = info.getHTMLInfo(ability);
		List<Map<String, String>> sections = InfoText.sections(html);
		boolean qualified = c.isQualifiedFor(ability);
		m.put("sections", sections);
		m.put("qualified", qualified);
		if (!qualified || InfoText.hasUnmetRequirement(html))
		{
			List<String> conflicts = conflicts(c, cat, ability, sections);
			List<String> unmet = Requirements.unmet(html);
			m.put("conflicts", conflicts);
			m.put("unmet", unmet);
			m.put("reason", conflicts.isEmpty() ? Requirements.sentence(unmet)
					: "You already have " + String.join(", ", conflicts) + ". Only one of this kind is allowed.");
		}
		if (q.bool("raw", false))
		{
			m.put("rawHtml", info.getHTMLInfo(ability));
		}
		return m;
	}

	private static final Pattern EXCLUSIVE = Pattern.compile("none of \\( at least \\d+ TYPE\\.(\\w+)");

	/**
	 * Abilities the character already has that make this one unavailable. Exclusive abilities (a character
	 * may have only one combat trait, say) say so in their requirements as "none of ( at least 1 TYPE.X ...)".
	 */
	private static List<String> conflicts(CharacterFacade c, AbilityCategory cat, AbilityFacade ability,
		List<Map<String, String>> sections)
	{
		List<String> out = new ArrayList<>();
		for (Map<String, String> sec : sections)
		{
			if (!"Requirements".equals(sec.get("label")))
			{
				continue;
			}
			Matcher m = EXCLUSIVE.matcher(sec.get("text"));
			while (m.find())
			{
				String type = m.group(1);
				for (AbilityFacade owned : c.getAbilities(cat))
				{
					if (!owned.getKeyName().equals(ability.getKeyName()) && owned.getType() != null
							&& List.of(owned.getType().split("\\.")).contains(type))
					{
						out.add("the " + type.replaceAll("(?<=[a-z])(?=[A-Z])", " ") + " " + owned);
					}
				}
			}
		}
		return out.stream().distinct().toList();
	}

	/** The note that carries the GM-granted feats into the character file and onto the sheet. */
	static final String GM_NOTE = "GM Granted Feats";

	/**
	 * Keeps the "GM Granted Feats" note in step with the abilities a GM handed out, one feat name per line. The note is
	 * saved with the character and read by the sheet export, which marks those feats "(GM)".
	 */
	static void syncGmNote(CharacterFacade c)
	{
		List<String> names = new ArrayList<>();
		var cats = c.getDataSet().getAbilities();
		for (String entry : SidecarAccess.gmGranted(c))
		{
			String[] parts = entry.split("\\|", 2);
			if (!"FEAT".equals(parts[0]))
			{
				continue;
			}
			for (AbilityFacade a : c.getAbilities(Lookup.find(c.getDataSet().getAbilities().getKeys(), parts[0], "ability category",
					AbilityCategory::getKeyName, AbilityCategory::getDisplayName)))
			{
				if (a.getKeyName().equals(parts[1]) && !names.contains(a.getKeyName()))
				{
					names.add(a.getKeyName());
				}
			}
		}
		var d = c.getDescriptionFacade();
		pcgen.core.NoteItem existing = null;
		for (pcgen.core.NoteItem n : d.getNotes())
		{
			if (GM_NOTE.equals(n.getName()))
			{
				existing = n;
			}
		}
		if (names.isEmpty())
		{
			if (existing != null)
			{
				d.deleteNote(existing);
			}
			return;
		}
		if (existing == null)
		{
			d.addNewNote();
			List<pcgen.core.NoteItem> all = new ArrayList<>();
			d.getNotes().forEach(all::add);
			existing = all.get(all.size() - 1);
			d.renameNote(existing, GM_NOTE);
		}
		d.setNote(existing, String.join("\n", names));
	}

	private AbilityCategory awards(CharacterFacade c)
	{
		AbilityCategory awards = SidecarAccess.awardsCategory(c);
		if (awards == null)
		{
			throw new ApiException(400, "this game has no GM awards");
		}
		return awards;
	}

	private AbilityFacade award(CharacterFacade c, AbilityCategory awards, String key)
	{
		return Lookup.find(c.getDataSet().getAbilities().getValue(awards), key, "GM award", AbilityFacade::getKeyName,
				Object::toString);
	}

	/** Sets how many extra feat slots the GM has handed out (PCGen's "+1 Bonus Feat" award, one selection per slot). */
	private Object bonusFeats(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		int want = q.requireInt("count");
		if (want < 0 || want > 99)
		{
			throw new ApiException(400, "count must be between 0 and 99");
		}
		AbilityCategory awards = awards(c);
		AbilityFacade slot = award(c, awards, SidecarAccess.SLOT_AWARD);
		int have = SidecarAccess.gmBonusSlots(c);
		while (have < want)
		{
			c.addAbility(awards, slot);
			have++;
		}
		while (have > want)
		{
			c.removeAbility(awards, slot);
			have--;
		}
		return characters.changed(id, c, Map.of("bonusSlots", SidecarAccess.gmBonusSlots(c)));
	}

	/** A language handed out by the GM (PCGen's "Add Language" award): name. */
	private Object gmLanguage(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		String name = q.requireStr("name");
		AbilityCategory awards = awards(c);
		AbilityFacade award = award(c, awards, SidecarAccess.LANGUAGE_AWARD);
		if (SidecarAccess.awardSelections(c, SidecarAccess.LANGUAGE_AWARD).stream().anyMatch(name::equalsIgnoreCase))
		{
			throw new ApiException(409, name + " was already given by the GM");
		}
		s.ui.withScriptedChoice(List.of(name), () -> c.addAbility(awards, award));
		if (SidecarAccess.awardSelections(c, SidecarAccess.LANGUAGE_AWARD).stream().noneMatch(name::equalsIgnoreCase))
		{
			throw new ApiException(404, "no language named '" + name + "' can be given (the character may know it already)");
		}
		return characters.changed(id, c, Map.of("added", name, "gm", true));
	}

	/** Takes back a language the GM handed out: name. */
	private Object gmLanguageRemove(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		String name = q.requireStr("name");
		AbilityCategory awards = awards(c);
		AbilityFacade award = award(c, awards, SidecarAccess.LANGUAGE_AWARD);
		if (SidecarAccess.awardSelections(c, SidecarAccess.LANGUAGE_AWARD).stream().noneMatch(name::equalsIgnoreCase))
		{
			throw new ApiException(404, name + " was not given by the GM");
		}
		s.ui.withScriptedChoice(List.of(), List.of(name), () -> c.addAbility(awards, award));
		return characters.changed(id, c, Map.of("removed", name, "gm", true));
	}

	private Object add(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		AbilityCategory cat = category(c, q.requireStr("category"));
		AbilityFacade ability = Lookup.find(c.getDataSet().getAbilities().getValue(cat), q.requireStr("name"),
				"ability in " + cat.getKeyName(), AbilityFacade::getKeyName, Object::toString);
		if (q.bool("gm", false))
		{
			// A feat handed out by the GM: PCGen's own award "Add a Feat Ignoring Restrictions" (no prerequisites, no slot).
			if (!"FEAT".equals(cat.getKeyName()))
			{
				throw new ApiException(400, "only feats can be flagged as granted by the GM");
			}
			AbilityCategory awards = awards(c);
			AbilityFacade award = award(c, awards, SidecarAccess.FEAT_AWARD);
			// A feat with choices (Skill Focus) is asked about, but only its own choices ("Skill Focus (Acrobatics)").
			s.ui.withScriptedChoice(List.of(ability.getKeyName()), List.of(), ability.getKeyName() + " (",
					() -> c.addAbility(awards, award));
			boolean there = SidecarAccess.gmGranted(c).contains("FEAT|" + ability.getKeyName());
			if (there && q.bool("slot", false))
			{
				// the feat still takes a feat slot; "+1 Bonus Feat" gives the character one so it costs nothing
				c.addAbility(awards, award(c, awards, SidecarAccess.SLOT_AWARD));
			}
			syncGmNote(c);
			return characters.changed(id, c, Map.of("added", there ? ability.getKeyName() : "", "gm", true));
		}
		c.addAbility(cat, ability);
		return characters.changed(id, c, Map.of("added", ability.getKeyName()));
	}

	private Object remove(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		AbilityCategory cat = category(c, q.requireStr("category"));
		AbilityFacade ability = Lookup.find(c.getAbilities(cat), q.requireStr("name"),
				"ability on this character in " + cat.getKeyName(), AbilityFacade::getKeyName, Object::toString);
		if (SidecarAccess.gmGranted(c).contains(cat.getKeyName() + "|" + ability.getKeyName()))
		{
			// Take the feat back out of the award's list of feats (the award itself stays).
			AbilityCategory awards = awards(c);
			AbilityFacade award = award(c, awards, SidecarAccess.FEAT_AWARD);
			if (award instanceof pcgen.core.Ability awardAbility)
			{
				SidecarAccess.revokeAwardedFeat(c, awardAbility, ability.getKeyName());
			}
			s.ui.withScriptedChoice(List.of(), List.of(ability.getKeyName()), () -> c.addAbility(awards, award));
			if (c.getAbilities(cat).containsElement(ability))
			{
				// the feat itself is also kept as an ordinary selection in the character; take that back too
				c.removeAbility(cat, ability);
			}
			syncGmNote(c);
			return characters.changed(id, c, Map.of("removed", ability.getKeyName(), "gm", true));
		}
		c.removeAbility(cat, ability);
		return characters.changed(id, c, Map.of("removed", ability.getKeyName()));
	}
}
