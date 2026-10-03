package pcgen.sidecar;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Supplier;

import pcgen.cdom.base.CDOMObject;
import pcgen.core.AbilityCategory;
import pcgen.core.Globals;
import pcgen.facade.core.DataSetFacade;
import pcgen.facade.core.InfoFacade;

/**
 * Read-only catalogs of what the loaded data set offers, for pickers in the UI. Every list
 * supports {@code q} (case-insensitive substring) and {@code limit} (default 200).
 */
final class DatasetRoutes
{
	private static final int DEFAULT_LIMIT = 200;

	private final Session s;
	private final Map<String, Supplier<Iterable<?>>> kinds = new LinkedHashMap<>();

	DatasetRoutes(Session s)
	{
		this.s = s;
		kinds.put("races", () -> s.dataSet().getRaces());
		kinds.put("classes", () -> s.dataSet().getClasses());
		kinds.put("deities", () -> s.dataSet().getDeities());
		kinds.put("templates", () -> s.dataSet().getTemplates());
		kinds.put("skills", () -> s.dataSet().getSkills());
		kinds.put("alignments", () -> s.dataSet().getAlignments());
		kinds.put("stats", () -> s.dataSet().getStats());
		kinds.put("sizes", () -> s.dataSet().getSizes());
		kinds.put("kits", () -> s.dataSet().getKits());
		kinds.put("equipment", () -> s.dataSet().getEquipment());
		kinds.put("xp-tables", () -> s.dataSet().getXPTableNames());
		kinds.put("character-types", () -> s.dataSet().getCharacterTypes());
		kinds.put("gear-buy-sell", () -> s.dataSet().getGearBuySellSchemes());
	}

	void register(Router r)
	{
		r.get("/dataset", this::summary);
		r.get("/dataset/abilities", this::abilities);
		r.get("/dataset/{kind}", this::list);
		r.get("/campaigns", this::campaigns);
	}

	private Map<String, Object> entry(Object o)
	{
		Map<String, Object> m = new LinkedHashMap<>();
		if (o instanceof CDOMObject c)
		{
			m.put("key", c.getKeyName());
			m.put("name", c.getDisplayName());
		}
		else if (o instanceof InfoFacade i)
		{
			m.put("key", i.getKeyName());
			m.put("name", i.toString());
		}
		else
		{
			m.put("name", String.valueOf(o));
		}
		if (o instanceof InfoFacade i)
		{
			m.put("source", i.getSource());
			m.put("type", i.getType());
		}
		return m;
	}

	private static boolean matches(Map<String, Object> e, String needle)
	{
		if (needle == null || needle.isBlank())
		{
			return true;
		}
		String n = needle.toLowerCase();
		return String.valueOf(e.get("name")).toLowerCase().contains(n)
				|| String.valueOf(e.get("key")).toLowerCase().contains(n);
	}

	private Map<String, Object> page(Iterable<?> items, Request q)
	{
		return page(items, q, null, null);
	}

	/**
	 * @param decorate adds extra fields to each returned entry
	 * @param include  drops entries for which it is false before they are counted (tested last, after the text
	 *                 search, because it can be slow)
	 */
	private Map<String, Object> page(Iterable<?> items, Request q, java.util.function.BiConsumer<Object, Map<String, Object>> decorate,
		java.util.function.Predicate<Object> include)
	{
		int limit = q.integer("limit") == null ? DEFAULT_LIMIT : q.requireInt("limit");
		String needle = q.str("q");
		List<Map<String, Object>> out = new ArrayList<>();
		int total = 0;
		for (Object o : items)
		{
			Map<String, Object> e = entry(o);
			if (!matches(e, needle) || (include != null && !include.test(o)))
			{
				continue;
			}
			total++;
			if (out.size() < limit)
			{
				if (decorate != null)
				{
					decorate.accept(o, e);
				}
				out.add(e);
			}
		}
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("total", total);
		m.put("items", out);
		return m;
	}

	private Object summary(Request q)
	{
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("gameMode", s.gameMode.getName());
		m.put("sources", s.campaignNames());
		Map<String, Object> counts = new LinkedHashMap<>();
		kinds.forEach((k, v) -> {
			int n = 0;
			for (Object ignored : v.get())
			{
				n++;
			}
			counts.put(k, n);
		});
		m.put("counts", counts);
		DataSetFacade d = s.dataSet();
		List<String> cats = new ArrayList<>();
		d.getAbilities().getKeys().forEach(k -> cats.add(k.getKeyName()));
		m.put("abilityCategories", cats);
		return m;
	}

	private Object list(Request q)
	{
		String kind = q.param("kind");
		Supplier<Iterable<?>> items = kinds.get(kind);
		if (items == null)
		{
			throw new ApiException(404, "unknown catalog '" + kind + "'; available: " + String.join(", ", kinds.keySet())
					+ ", abilities");
		}
		return page(items.get(), q);
	}

	private Object abilities(Request q)
	{
		AbilityCategory cat = Lookup.find(s.dataSet().getAbilities().getKeys(), q.requireStr("category"),
				"ability category", AbilityCategory::getKeyName, AbilityCategory::getDisplayName);
		// With ?character=<id>, say which abilities that character may actually take.
		pcgen.facade.core.CharacterFacade who = q.has("character") ? s.character(q.requireStr("character")) : null;
		// With ?qualified=true, leave out what that character can't take at all.
		boolean onlyQualified = who != null && q.bool("qualified", false);
		return page(s.dataSet().getAbilities().getValue(cat), q, who == null ? null : (o, e) -> {
			if (o instanceof pcgen.facade.core.AbilityFacade a)
			{
				e.put("qualified", who.isQualifiedFor(a));
			}
		}, onlyQualified ? o -> !(o instanceof pcgen.facade.core.AbilityFacade a) || who.isQualifiedFor(a) : null);
	}

	/** Every campaign (source book) the engine knows about, for choosing a source set to launch with. */
	private Object campaigns(Request q)
	{
		List<Map<String, Object>> out = new ArrayList<>();
		String needle = q.str("q");
		for (var c : Globals.getCampaignList())
		{
			Map<String, Object> m = new LinkedHashMap<>();
			m.put("key", c.getKeyName());
			m.put("name", c.getDisplayName());
			if (matches(m, needle))
			{
				out.add(m);
			}
		}
		return Map.of("total", out.size(), "items", out);
	}
}
