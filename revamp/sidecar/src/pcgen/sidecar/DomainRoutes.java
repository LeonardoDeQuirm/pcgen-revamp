package pcgen.sidecar;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import pcgen.core.Domain;
import pcgen.core.QualifiedObject;
import pcgen.facade.core.CharacterFacade;

/**
 * Domains (a cleric's, and the like): which ones the character has, how many it may still take, and the ones on offer
 * with their descriptions. Adding and removing is in CharacterRoutes.
 */
final class DomainRoutes
{
	private final Session s;

	DomainRoutes(Session s)
	{
		this.s = s;
	}

	void register(Router r)
	{
		r.get("/characters/{id}/domains", this::view);
		r.get("/characters/{id}/domains/info", this::info);
	}

	private static Map<String, Object> entry(CharacterFacade c, QualifiedObject<Domain> d)
	{
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("key", d.getRawObject().getKeyName());
		m.put("name", d.getRawObject().getDisplayName());
		m.put("qualified", c.isQualifiedFor(d));
		m.put("source", d.getRawObject().getSource());
		return m;
	}

	private Object view(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		List<Map<String, Object>> selected = new ArrayList<>();
		for (QualifiedObject<Domain> d : c.getDomains())
		{
			selected.add(entry(c, d));
		}
		List<Map<String, Object>> available = new ArrayList<>();
		String needle = q.str("q") == null ? "" : q.str("q").toLowerCase();
		for (QualifiedObject<Domain> d : c.getAvailableDomains())
		{
			Map<String, Object> e = entry(c, d);
			if (needle.isEmpty() || String.valueOf(e.get("name")).toLowerCase().contains(needle))
			{
				available.add(e);
			}
		}
		Integer remaining = c.getRemainingDomainSelectionsRef().get();
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("selected", selected);
		m.put("remaining", remaining == null ? 0 : remaining);
		m.put("available", available);
		return m;
	}

	private Object info(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		QualifiedObject<Domain> domain = Lookup.find(c.getAvailableDomains(), q.requireStr("name"), "domain",
				d -> d.getRawObject().getKeyName(), d -> d.getRawObject().getDisplayName());
		String html = c.getInfoFactory().getHTMLInfo(domain);
		boolean qualified = c.isQualifiedFor(domain);
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("key", domain.getRawObject().getKeyName());
		m.put("name", domain.getRawObject().getDisplayName());
		m.put("sections", InfoText.sections(html));
		m.put("qualified", qualified);
		if (!qualified)
		{
			List<String> unmet = Requirements.unmet(html);
			m.put("reason", unmet.isEmpty() ? "This character does not meet the requirements for this domain."
					: Requirements.sentence(unmet));
		}
		return m;
	}
}
