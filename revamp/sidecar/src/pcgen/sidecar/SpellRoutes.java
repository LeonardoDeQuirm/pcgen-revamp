package pcgen.sidecar;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import pcgen.cdom.enumeration.FactKey;
import pcgen.cdom.enumeration.IntegerKey;
import pcgen.cdom.list.DomainSpellList;
import pcgen.core.Ability;
import pcgen.core.AbilityCategory;
import pcgen.core.spell.Spell;
import pcgen.core.character.SpellInfo;
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

	/** The character's metamagic feats: the only ones that may be applied. Each raises the spell's slot level. */
	private List<Ability> metamagicFeats(PlayerCharacter pc)
	{
		List<Ability> out = new ArrayList<>();
		for (var cna : pc.getCNAbilities(AbilityCategory.FEAT))
		{
			Ability a = cna.getAbility();
			if (a.isType("Metamagic") && !out.contains(a))
			{
				out.add(a);
			}
		}
		out.sort(java.util.Comparator.comparing(Ability::getDisplayName));
		return out;
	}

	/** The level a spell has on its list: the level it is held at, less what its metamagic feats added. */
	private static int baseLevel(SpellNode n)
	{
		int level;
		try
		{
			level = Integer.parseInt(n.getSpellLevel());
		}
		catch (NumberFormatException e)
		{
			return 0;
		}
		SpellInfo info = SidecarAccess.spellInfoOf(n.getSpell());
		if (info != null && info.getFeatList() != null)
		{
			for (Ability a : info.getFeatList())
			{
				level -= a.getSafe(IntegerKey.ADD_SPELL_LEVEL);
			}
		}
		return level;
	}

	private static List<String> metamagicNames(SpellNode n)
	{
		SpellInfo info = SidecarAccess.spellInfoOf(n.getSpell());
		List<String> names = new ArrayList<>();
		if (info != null && info.getFeatList() != null)
		{
			info.getFeatList().forEach(a -> names.add(a.getKeyName()));
		}
		java.util.Collections.sort(names);
		return names;
	}

	/**
	 * Which domain a spell on a class's list comes from: the domain whose list holds it at this level when the
	 * class's own list does not (a cleric's Burning Hands from the Fire domain). Null for ordinary class spells.
	 */
	private static String domainOf(PlayerCharacter pc, SpellNode n)
	{
		PCClass cls = n.getSpellcastingClass();
		Spell spell = SidecarAccess.spellOf(n.getSpell());
		if (cls == null || spell == null)
		{
			return null;
		}
		// Metamagic changes the level it is held at, not the level it has on the list.
		int level = baseLevel(n);
		var levelsByList = pc.getSpellLevelInfo(spell);
		// On the class's own list at this level: an ordinary class spell, whatever else also lists it.
		for (var list : pc.getDisplay().getSpellLists(cls))
		{
			List<Integer> levels = levelsByList.getListFor(list);
			if (!(list instanceof DomainSpellList) && levels != null && levels.contains(level))
			{
				return null;
			}
		}
		// Otherwise it is there because of a domain: the one whose list holds it at this level.
		String domain = null;
		for (var list : levelsByList.getKeySet())
		{
			List<Integer> levels = levelsByList.getListFor(list);
			if (list instanceof DomainSpellList && levels != null && levels.contains(level) && domain == null)
			{
				domain = list.getKeyName();
			}
		}
		return domain;
	}

	private Map<String, Object> node(SpellNode n, PlayerCharacter pc)
	{
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("class", n.getSpellcastingClass() == null ? null : n.getSpellcastingClass().getKeyName());
		m.put("level", n.getSpellLevel());
		List<String> meta = n.getSpell() == null ? List.of() : metamagicNames(n);
		// With metamagic the engine decorates the name ("Magic Missile [Empower Spell]"): give the plain name and
		// list the feats apart.
		String domain = n.getSpell() == null || pc == null ? null : domainOf(pc, n);
		// A domain spell is shown by the engine as "Burning Hands [Fire]": give the plain name and the domain apart.
		m.put("spell", n.getSpell() == null ? null
				: meta.isEmpty() && domain == null ? n.getSpell().toString() : n.getSpell().getKeyName());
		m.put("list", n.getRootNode() == null ? null : n.getRootNode().getName());
		m.put("count", n.getCount());
		if (n.getSpell() != null)
		{
			m.put("baseLevel", baseLevel(n));
			m.put("metamagic", meta);
			m.put("domain", domain);
		}
		return m;
	}

	private List<Map<String, Object>> nodes(ListFacade<? extends SpellSupportFacade.SuperNode> list, String className,
		int limit, PlayerCharacter pc)
	{
		List<Map<String, Object>> out = new ArrayList<>();
		// The engine can list the same spell twice (e.g. once per spell list that grants it); keep one.
		java.util.Set<String> seen = new java.util.HashSet<>();
		for (SpellSupportFacade.SuperNode sn : list)
		{
			if (sn instanceof SpellNode n && n.getSpell() != null
					&& (className == null || (n.getSpellcastingClass() != null
							&& className.equalsIgnoreCase(n.getSpellcastingClass().getKeyName()))))
			{
				Map<String, Object> row = node(n, pc);
				if (!seen.add(row.get("class") + "|" + row.get("level") + "|" + row.get("spell") + "|" + row.get("list")
						+ "|" + row.get("metamagic")))
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
		PlayerCharacter pc = SidecarAccess.playerCharacter(c);
		String cls = q.str("class");
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("known", nodes(sp.getKnownSpellNodes(), cls, Integer.MAX_VALUE, pc));
		m.put("prepared", nodes(sp.getPreparedSpellNodes(), cls, Integer.MAX_VALUE, pc));
		m.put("book", nodes(sp.getBookSpellNodes(), cls, Integer.MAX_VALUE, null));
		List<Map<String, Object>> meta = new ArrayList<>();
		for (Ability a : metamagicFeats(pc))
		{
			Map<String, Object> f = new LinkedHashMap<>();
			f.put("key", a.getKeyName());
			f.put("name", a.getDisplayName());
			f.put("levelAdjust", a.getSafe(IntegerKey.ADD_SPELL_LEVEL));
			meta.add(f);
		}
		m.put("metamagicFeats", meta);
		m.put("classes", classes(c));
		// A prepared list or spell book exists once it has been created, even while it holds nothing; the engine
		// shows an empty one as a header entry without a spell.
		java.util.Set<String> lists = new java.util.LinkedHashSet<>(CharacterView.names(sp.getSpellbooks()));
		// Every list that has a prepared spell in it, plus the empty ones (shown as a header without a spell).
		for (SpellSupportFacade.SuperNode sn : sp.getPreparedSpellNodes())
		{
			if (sn instanceof SpellNode n && n.getRootNode() != null)
			{
				lists.add(n.getRootNode().getName());
			}
		}
		m.put("spellbooks", new ArrayList<>(lists));
		m.put("defaultSpellbook", sp.getDefaultSpellBookRef().get());
		m.put("autoSpells", sp.isAutoSpells());
		m.put("useHigherKnownSlots", sp.isUseHigherKnownSlots());
		m.put("useHigherPreppedSlots", sp.isUseHigherPreppedSlots());
		if (q.bool("available", false))
		{
			m.put("available", nodes(sp.getAvailableSpellNodes(), cls, q.integer("limit") == null ? 500 : q.requireInt("limit"), null));
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
			Map<String, Integer> preparedNow = new java.util.HashMap<>();
			Map<String, Integer> preparedDomain = new java.util.HashMap<>();
			for (SpellSupportFacade.SuperNode sn : sp.getPreparedSpellNodes())
			{
				if (sn instanceof SpellNode n && n.getSpell() != null && n.getSpellcastingClass() != null
						&& n.getSpellcastingClass().equals(cls))
				{
					// A domain spell fills the separate domain slot, not one of the day's ordinary ones.
					(domainOf(pc, n) != null ? preparedDomain : preparedNow).merge(n.getSpellLevel(), n.getCount(),
							Integer::sum);
				}
			}
			Map<String, Integer> knownNow = new java.util.HashMap<>();
			for (SpellSupportFacade.SuperNode sn : sp.getKnownSpellNodes())
			{
				if (sn instanceof SpellNode n && n.getSpellcastingClass() != null && n.getSpellcastingClass().equals(cls)
						&& domainOf(pc, n) == null)
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
				// An extra slot that is kept apart from the daily total: a cleric's domain slot or a specialist
				// wizard's school slot. The engine says it as "+1".
				lv.put("bonus", ss.getBonusCastForLevelString(i, Globals.getDefaultSpellBook(), pc));
				lv.put("prepared", preparedNow.getOrDefault(String.valueOf(i), 0));
				lv.put("preparedDomain", preparedDomain.getOrDefault(String.valueOf(i), 0));
				lv.put("usable", cast > 0 || known > 0);
				levels.add(lv);
			}
			Map<String, Object> m = new LinkedHashMap<>();
			m.put("class", cls.getKeyName());
			m.put("classLevel", pc.getLevel(cls));
			m.put("casterType", cls.getSpellType());
			// Prepared casters (wizard, cleric, druid...) choose their spells each day; the others (sorcerer,
			// bard, inquisitor...) simply know them and cast any number up to their daily total.
			m.put("prepares", cls.getSafe(pcgen.cdom.enumeration.ObjectKey.MEMORIZE_SPELLS));
			m.put("highestLevel", highest);
			m.put("levels", levels);
			out.add(m);
		}
		return out;
	}

	private SpellNode find(ListFacade<? extends SpellSupportFacade.SuperNode> list, Request q, String what)
	{
		return find(list, q, what, q.str("list"));
	}

	/** @param listName only match entries in the spell list / book of this name (null: any) */
	private SpellNode find(ListFacade<? extends SpellSupportFacade.SuperNode> list, Request q, String what,
		String listName)
	{
		String cls = q.requireStr("class");
		String level = q.requireStr("level");
		String spell = q.requireStr("spell");
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
		// "list" is the book to prepare INTO; the spell itself is found among the known spells (optionally narrowed
		// with "from", the list it is known in).
		SpellNode n = find(sp.getAllKnownSpellNodes(), q, "known", q.str("from"));
		// "metamagic" is a list of feat names. Only feats the character really has may be used; the engine asks
		// which to apply as a chooser, which is answered here from the list.
		List<String> wanted = q.strList("metamagic");
		if (wanted.isEmpty() || wanted.stream().allMatch(w -> w.equalsIgnoreCase("false")))
		{
			sp.addPreparedSpell(n, q.requireStr("list"), false);
			return done(q);
		}
		List<Ability> own = metamagicFeats(SidecarAccess.playerCharacter(s.character(q.param("id"))));
		List<String> keys = new ArrayList<>();
		for (String w : wanted)
		{
			Ability hit = own.stream()
					.filter(a -> w.equalsIgnoreCase(a.getKeyName()) || w.equalsIgnoreCase(a.getDisplayName()))
					.findFirst().orElseThrow(() -> new ApiException(400, "this character does not have the metamagic feat '"
							+ w + "'; it has: " + (own.isEmpty() ? "none" : own.stream().map(Ability::getDisplayName)
									.collect(java.util.stream.Collectors.joining(", ")))));
			keys.add(hit.getKeyName());
		}
		s.ui.withScriptedChoice(keys, () -> sp.addPreparedSpell(n, q.requireStr("list"), true));
		return done(q);
	}

	private SpellNode findPrepared(SpellSupportFacade sp, Request q, java.util.Set<String> wantedFeats)
	{
		String list = q.requireStr("list");
		String cls = q.requireStr("class");
		String level = q.requireStr("level");
		String spell = q.requireStr("spell");
		for (SpellSupportFacade.SuperNode sn : sp.getPreparedSpellNodes())
		{
			if (!(sn instanceof SpellNode n) || n.getSpell() == null || n.getSpellcastingClass() == null
					|| n.getRootNode() == null || !list.equalsIgnoreCase(n.getRootNode().getName()))
			{
				continue;
			}
			java.util.Set<String> have = new java.util.TreeSet<>(String.CASE_INSENSITIVE_ORDER);
			have.addAll(metamagicNames(n));
			if ((spell.equalsIgnoreCase(n.getSpell().toString()) || spell.equalsIgnoreCase(n.getSpell().getKeyName()))
					&& cls.equalsIgnoreCase(n.getSpellcastingClass().getKeyName()) && level.equals(n.getSpellLevel())
					&& have.equals(wantedFeats))
			{
				return n;
			}
		}
		throw new ApiException(404, "no prepared spell '" + spell + "' for class " + cls + " level " + level + " in list "
				+ list + (wantedFeats.isEmpty() ? "" : " with " + wantedFeats));
	}

	private Object removePrepared(Request q)
	{
		SpellSupportFacade sp = s.character(q.param("id")).getSpellSupport();
		// Several copies of a spell can be held with different metamagic: the one asked for has the same feats.
		java.util.Set<String> wanted = new java.util.TreeSet<>(String.CASE_INSENSITIVE_ORDER);
		wanted.addAll(q.strList("metamagic"));
		SpellNode n = findPrepared(sp, q, wanted);
		sp.removePreparedSpell(n, q.requireStr("list"));
		return done(q);
	}

	private Object addToBook(Request q)
	{
		SpellSupportFacade sp = s.character(q.param("id")).getSpellSupport();
		SpellNode n = find(sp.getAllKnownSpellNodes(), q, "known", q.str("from"));
		sp.addToSpellBook(n, q.requireStr("book"));
		return done(q);
	}

	private Object removeFromBook(Request q)
	{
		SpellSupportFacade sp = s.character(q.param("id")).getSpellSupport();
		SpellNode n = find(sp.getBookSpellNodes(), q, "spell book", q.requireStr("book"));
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
