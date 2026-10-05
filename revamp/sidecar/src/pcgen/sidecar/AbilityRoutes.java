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
	private void syncGmNote(CharacterFacade c)
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
			for (AbilityFacade a : c.getAbilities(category(c, parts[0])))
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

	private Object add(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		AbilityCategory cat = category(c, q.requireStr("category"));
		AbilityFacade ability = Lookup.find(c.getDataSet().getAbilities().getValue(cat), q.requireStr("name"),
				"ability in " + cat.getKeyName(), AbilityFacade::getKeyName, Object::toString);
		if (q.bool("gm", false))
		{
			// A GM-granted feat: no prerequisites, no feat slot, saved with the character and marked on the sheet.
			if (!"FEAT".equals(cat.getKeyName()) || !(ability instanceof pcgen.core.Ability real))
			{
				throw new ApiException(400, "only feats can be flagged as granted by the GM");
			}
			SidecarAccess.addGmAbility(c, cat, real);
			boolean there = SidecarAccess.gmGranted(c).contains(cat.getKeyName() + "|" + real.getKeyName());
			if (there)
			{
				syncGmNote(c);
			}
			return characters.changed(id, c, Map.of("added", there ? real.getKeyName() : "", "gm", true));
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
		if (ability instanceof pcgen.core.Ability real && SidecarAccess.gmGranted(c).contains(cat.getKeyName() + "|" + real.getKeyName()))
		{
			SidecarAccess.removeGmAbility(c, cat, real);
			syncGmNote(c);
			return characters.changed(id, c, Map.of("removed", ability.getKeyName(), "gm", true));
		}
		c.removeAbility(cat, ability);
		return characters.changed(id, c, Map.of("removed", ability.getKeyName()));
	}
}
