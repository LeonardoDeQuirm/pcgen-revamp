package pcgen.sidecar;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import pcgen.core.Language;
import pcgen.facade.core.CharacterFacade;
import pcgen.facade.core.LanguageChooserFacade;

/**
 * Languages. Automatic ones (race, class) come with the character. Others are picked through
 * "choosers": each says how many more languages may be chosen and from which list. Choose with
 * {@code POST /characters/{id}/languages}, remove a learned one with {@code DELETE}.
 */
final class LanguageRoutes
{
	private final Session s;
	private final CharacterRoutes characters;

	LanguageRoutes(Session s, CharacterRoutes characters)
	{
		this.s = s;
		this.characters = characters;
	}

	void register(Router r)
	{
		r.get("/characters/{id}/languages", q -> view(s.character(q.param("id"))));
		r.post("/characters/{id}/languages", this::choose);
		r.delete("/characters/{id}/languages", this::remove);
	}

	private List<LanguageChooserFacade> choosers(CharacterFacade c)
	{
		List<LanguageChooserFacade> out = new ArrayList<>();
		c.getLanguageChoosers().forEach(out::add);
		return out;
	}

	private Map<String, Object> view(CharacterFacade c)
	{
		Map<String, Object> m = new LinkedHashMap<>();
		List<Map<String, Object>> known = CharacterView.languages(c);
		List<String> fromGm = pcgen.gui2.facade.SidecarAccess.awardSelections(c, pcgen.gui2.facade.SidecarAccess.LANGUAGE_AWARD);
		for (Map<String, Object> l : known)
		{
			if (fromGm.stream().anyMatch(String.valueOf(l.get("name"))::equalsIgnoreCase))
			{
				l.put("gm", true);
			}
		}
		m.put("languages", known);
		// Languages a GM could hand out: every spoken language the character does not know yet. Absent when the game
		// has no GM awards.
		if (pcgen.gui2.facade.SidecarAccess.awardsCategory(c) != null)
		{
			List<String> could = new ArrayList<>();
			for (Language lang : pcgen.core.Globals.getContext().getReferenceContext().getConstructedCDOMObjects(Language.class))
			{
				if (lang.isType("Spoken") && known.stream().noneMatch(k -> lang.getDisplayName().equals(k.get("name"))))
				{
					could.add(lang.getDisplayName());
				}
			}
			java.util.Collections.sort(could);
			m.put("gmAvailable", could);
		}
		List<Map<String, Object>> cs = new ArrayList<>();
		List<LanguageChooserFacade> list = choosers(c);
		for (int i = 0; i < list.size(); i++)
		{
			LanguageChooserFacade ch = list.get(i);
			Map<String, Object> cm = new LinkedHashMap<>();
			cm.put("index", i);
			cm.put("name", ch.getName());
			// The engine fills a chooser lazily: it works out the remaining count when the
			// available list is first requested, so that must be read first.
			List<String> available = CharacterView.names(ch.getAvailableList());
			cm.put("remaining", ch.getRemainingSelections().get());
			cm.put("available", available);
			cm.put("selected", CharacterView.names(ch.getSelectedList()));
			cs.add(cm);
		}
		m.put("choosers", cs);
		return m;
	}

	/**
	 * Adds and/or drops languages in one chooser, then commits. Note the first chooser (bonus
	 * languages) only has picks at first level unless the game rules allow more. If anything is wrong the chooser
	 * is rolled back and nothing changes.
	 */
	private Object choose(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		List<LanguageChooserFacade> list = choosers(c);
		int index = q.integer("chooser") == null ? 0 : q.requireInt("chooser");
		if (index < 0 || index >= list.size())
		{
			throw new ApiException(list.isEmpty() ? 409 : 400, list.isEmpty()
					? "this character has no language choices to make"
					: "chooser must be between 0 and " + (list.size() - 1));
		}
		LanguageChooserFacade ch = list.get(index);
		// getAvailableList() makes the engine rebuild the whole chooser (selected list and remaining
		// count included), so call it exactly once and keep the list; the edits below build on that.
		var available = ch.getAvailableList();
		var selected = ch.getSelectedList();
		try
		{
			for (String name : q.strList("remove"))
			{
				ch.removeSelected(Lookup.pObject(selected, name, "selected language"));
			}
			for (String name : q.strList("add"))
			{
				Language lang = Lookup.pObject(available, name, "available language");
				if (ch.getRemainingSelections().get() <= 0)
				{
					throw new ApiException(409, "no language choices left in this chooser");
				}
				ch.addSelected(lang);
			}
		}
		catch (RuntimeException e)
		{
			ch.rollback();
			throw e;
		}
		ch.commit();
		return characters.changed(id, c, Map.of("languages", view(c)));
	}

	private Object remove(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		Language lang = Lookup.pObject(c.getLanguages(), q.requireStr("name"), "language on this character");
		if (!c.isRemovable(lang))
		{
			throw new ApiException(409, "language " + lang.getKeyName() + " cannot be removed");
		}
		c.removeLanguage(lang);
		return characters.changed(id, c, Map.of("languages", view(c)));
	}
}
