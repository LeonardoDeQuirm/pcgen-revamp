package pcgen.sidecar;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import pcgen.cdom.enumeration.FactKey;
import pcgen.core.Globals;
import pcgen.core.PCClass;
import pcgen.core.PlayerCharacter;
import pcgen.core.SpellSupportForPCClass;
import pcgen.facade.core.CharacterFacade;
import pcgen.gui2.facade.SidecarAccess;
import pcgen.facade.core.SpellSupportFacade;
import pcgen.facade.core.SpellSupportFacade.SpellNode;
import pcgen.facade.util.ListFacade;

/**
 * Spells. A spell is identified by (class, spell level, spell name); the same spell can appear
 * in several classes or levels. "Known" is what a spontaneous caster knows, "prepared" what a
 * preparing caster has readied in a spell list, and a spell book holds scribed spells.
 */
final class SpellRoutes
{
	private final Session s;
	private final CharacterRoutes characters;

	SpellRoutes(Session s, CharacterRoutes characters)
	{
		this.s = s;
		this.characters = characters;
	}

	void register(Router r)
	{
		r.get("/characters/{id}/spells", this::view);
		r.get("/characters/{id}/spells/info", this::info);
		r.post("/characters/{id}/spells/known", this::addKnown);
		r.delete("/characters/{id}/spells/known", this::removeKnown);
		r.post("/characters/{id}/spells/prepared", this::addPrepared);
		r.delete("/characters/{id}/spells/prepared", this::removePrepared);
		r.post("/characters/{id}/spells/book", this::addToBook);
		r.delete("/characters/{id}/spells/book", this::removeFromBook);
		r.post("/characters/{id}/spellbooks", this::addBook);
		r.delete("/characters/{id}/spellbooks", this::removeBook);
		r.patch("/characters/{id}/spells/settings", this::settings);
	}

	private Map<String, Object> node(SpellNode n)
	{
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("class", n.getSpellcastingClass() == null ? null : n.getSpellcastingClass().getKeyName());
		m.put("level", n.getSpellLevel());
		m.put("spell", n.getSpell() == null ? null : n.getSpell().toString());
		m.put("list", n.getRootNode() == null ? null : n.getRootNode().getName());
		m.put("count", n.getCount());
		return m;
	}

	private List<Map<String, Object>> nodes(ListFacade<? extends SpellSupportFacade.SuperNode> list, String className,
		int limit)
	{
		List<Map<String, Object>> out = new ArrayList<>();
		// The engine can list the same spell twice (e.g. once per spell list that grants it); keep one.
		java.util.Set<String> seen = new java.util.HashSet<>();
		for (SpellSupportFacade.SuperNode sn : list)
		{
			if (sn instanceof SpellNode n
					&& (className == null || (n.getSpellcastingClass() != null
							&& className.equalsIgnoreCase(n.getSpellcastingClass().getKeyName()))))
			{
				Map<String, Object> row = node(n);
				if (!seen.add(row.get("class") + "|" + row.get("level") + "|" + row.get("spell") + "|" + row.get("list")))
				{
					continue;
				}
				out.add(row);
				if (out.size() >= limit)
				{
					break;
				}
			}
		}
		return out;
	}

	/** {@code available=true} adds the (large) list of spells that could be added; filter with {@code class}. */
	private Object view(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		SpellSupportFacade sp = c.getSpellSupport();
		String cls = q.str("class");
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("known", nodes(sp.getKnownSpellNodes(), cls, Integer.MAX_VALUE));
		m.put("prepared", nodes(sp.getPreparedSpellNodes(), cls, Integer.MAX_VALUE));
		m.put("book", nodes(sp.getBookSpellNodes(), cls, Integer.MAX_VALUE));
		m.put("classes", classes(c));
		m.put("spellbooks", CharacterView.names(sp.getSpellbooks()));
		m.put("defaultSpellbook", sp.getDefaultSpellBookRef().get());
		m.put("autoSpells", sp.isAutoSpells());
		m.put("useHigherKnownSlots", sp.isUseHigherKnownSlots());
		m.put("useHigherPreppedSlots", sp.isUseHigherPreppedSlots());
		if (q.bool("available", false))
		{
			m.put("available", nodes(sp.getAvailableSpellNodes(), cls, q.integer("limit") == null ? 500 : q.requireInt("limit")));
		}
		return m;
	}

	/**
	 * Per spellcasting class: which spell levels it can use right now and how many spells that means.
	 * "Per day" and "known" are the engine's own figures (class level, ability score and bonuses all
	 * counted), so a level is only worth offering when one of them is above zero. A wizard gains new
	 * levels as it levels up; a level-1 wizard has just levels 0 and 1.
	 */
	private List<Map<String, Object>> classes(CharacterFacade c)
	{
		PlayerCharacter pc = SidecarAccess.playerCharacter(c);
		SpellSupportFacade sp = c.getSpellSupport();
		List<Map<String, Object>> out = new ArrayList<>();
		for (PCClass cls : pc.getDisplay().getClassSet())
		{
			if (cls.get(FactKey.valueOf("SpellType")) == null)
			{
				continue;
			}
			SpellSupportForPCClass ss = pc.getSpellSupport(cls);
			if (!(ss.canCastSpells(pc) || ss.hasKnownList()))
			{
				continue;
			}
			int highest = ss.getHighestLevelSpell(pc);
			Map<String, Integer> knownNow = new java.util.HashMap<>();
			for (SpellSupportFacade.SuperNode sn : sp.getKnownSpellNodes())
			{
				if (sn instanceof SpellNode n && n.getSpellcastingClass() != null && n.getSpellcastingClass().equals(cls))
				{
					knownNow.merge(n.getSpellLevel(), 1, Integer::sum);
				}
			}
			List<Map<String, Object>> levels = new ArrayList<>();
			for (int i = 0; i <= Math.max(highest, 0); i++)
			{
				int cast = ss.getCastForLevel(i, Globals.getDefaultSpellBook(), true, false, pc);
				int known = ss.getKnownForLevel(i, pc);
				Map<String, Object> lv = new LinkedHashMap<>();
				lv.put("level", i);
				lv.put("perDay", cast);
				lv.put("known", known);
				lv.put("knownNow", knownNow.getOrDefault(String.valueOf(i), 0));
				lv.put("usable", cast > 0 || known > 0);
				levels.add(lv);
			}
			Map<String, Object> m = new LinkedHashMap<>();
			m.put("class", cls.getKeyName());
			m.put("classLevel", pc.getLevel(cls));
			m.put("casterType", cls.getSpellType());
			m.put("highestLevel", highest);
			m.put("levels", levels);
			out.add(m);
		}
		return out;
	}

	private SpellNode find(ListFacade<? extends SpellSupportFacade.SuperNode> list, Request q, String what)
	{
		String cls = q.requireStr("class");
		String level = q.requireStr("level");
		String spell = q.requireStr("spell");
		String listName = q.str("list");
		List<String> near = new ArrayList<>();
		for (SpellSupportFacade.SuperNode sn : list)
		{
			if (!(sn instanceof SpellNode n) || n.getSpell() == null || n.getSpellcastingClass() == null)
			{
				continue;
			}
			boolean sameSpell = spell.equalsIgnoreCase(n.getSpell().toString())
					|| spell.equalsIgnoreCase(n.getSpell().getKeyName());
			if (sameSpell && cls.equalsIgnoreCase(n.getSpellcastingClass().getKeyName())
					&& level.equals(n.getSpellLevel())
					&& (listName == null || (n.getRootNode() != null && listName.equalsIgnoreCase(n.getRootNode().getName()))))
			{
				return n;
			}
			if (sameSpell && near.size() < 5)
			{
				near.add(n.getSpellcastingClass().getKeyName() + " level " + n.getSpellLevel());
			}
		}
		throw new ApiException(404, "no " + what + " spell '" + spell + "' for class " + cls + " level " + level
				+ (near.isEmpty() ? "" : "; that spell exists as: " + String.join(", ", near)));
	}

	/** The spell as the character sees it: school, components, range, saving throw, full description. */
	private Object info(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		SpellSupportFacade sp = c.getSpellSupport();
		SpellNode node = null;
		ApiException notFound = null;
		boolean known = false;
		for (ListFacade<? extends SpellSupportFacade.SuperNode> list : List.of(sp.getKnownSpellNodes(),
				sp.getPreparedSpellNodes(), sp.getBookSpellNodes(), sp.getAvailableSpellNodes()))
		{
			try
			{
				node = find(list, q, "known or available");
				known = list == sp.getKnownSpellNodes();
				break;
			}
			catch (ApiException e)
			{
				notFound = e;
			}
		}
		if (node == null)
		{
			throw notFound;
		}
		String html = c.getInfoFactory().getHTMLInfo(node.getSpell());
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("name", node.getSpell().toString());
		m.put("class", node.getSpellcastingClass().getKeyName());
		m.put("level", node.getSpellLevel());
		m.put("known", known);
		m.put("description", c.getInfoFactory().getDescription(node.getSpell()));
		m.put("sections", InfoText.sections(html));
		return m;
	}

	private Object done(Request q)
	{
		return characters.changed(q.param("id"), s.character(q.param("id")), Map.of());
	}

	private Object addKnown(Request q)
	{
		SpellSupportFacade sp = s.character(q.param("id")).getSpellSupport();
		sp.addKnownSpell(find(sp.getAvailableSpellNodes(), q, "available"));
		return done(q);
	}

	private Object removeKnown(Request q)
	{
		SpellSupportFacade sp = s.character(q.param("id")).getSpellSupport();
		sp.removeKnownSpell(find(sp.getKnownSpellNodes(), q, "known"));
		return done(q);
	}

	private Object addPrepared(Request q)
	{
		SpellSupportFacade sp = s.character(q.param("id")).getSpellSupport();
		SpellNode n = find(sp.getAllKnownSpellNodes(), q, "known");
		sp.addPreparedSpell(n, q.requireStr("list"), q.bool("metamagic", false));
		return done(q);
	}

	private Object removePrepared(Request q)
	{
		SpellSupportFacade sp = s.character(q.param("id")).getSpellSupport();
		SpellNode n = find(sp.getPreparedSpellNodes(), q, "prepared");
		sp.removePreparedSpell(n, q.requireStr("list"));
		return done(q);
	}

	private Object addToBook(Request q)
	{
		SpellSupportFacade sp = s.character(q.param("id")).getSpellSupport();
		SpellNode n = find(sp.getAllKnownSpellNodes(), q, "known");
		sp.addToSpellBook(n, q.requireStr("book"));
		return done(q);
	}

	private Object removeFromBook(Request q)
	{
		SpellSupportFacade sp = s.character(q.param("id")).getSpellSupport();
		SpellNode n = find(sp.getBookSpellNodes(), q, "spell book");
		sp.removeFromSpellBook(n, q.requireStr("book"));
		return done(q);
	}

	private Object addBook(Request q)
	{
		s.character(q.param("id")).getSpellSupport().addSpellList(q.requireStr("name"));
		return done(q);
	}

	private Object removeBook(Request q)
	{
		s.character(q.param("id")).getSpellSupport().removeSpellList(q.requireStr("name"));
		return done(q);
	}

	private Object settings(Request q)
	{
		SpellSupportFacade sp = s.character(q.param("id")).getSpellSupport();
		if (q.has("autoSpells"))
		{
			sp.setAutoSpells(q.bool("autoSpells", sp.isAutoSpells()));
		}
		if (q.has("useHigherKnownSlots"))
		{
			sp.setUseHigherKnownSlots(q.bool("useHigherKnownSlots", sp.isUseHigherKnownSlots()));
		}
		if (q.has("useHigherPreppedSlots"))
		{
			sp.setUseHigherPreppedSlots(q.bool("useHigherPreppedSlots", sp.isUseHigherPreppedSlots()));
		}
		if (q.has("defaultSpellbook"))
		{
			sp.setDefaultSpellBook(q.requireStr("defaultSpellbook"));
		}
		return done(q);
	}
}
