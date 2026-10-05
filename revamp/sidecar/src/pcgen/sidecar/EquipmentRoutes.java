package pcgen.sidecar;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import pcgen.facade.core.CharacterFacade;
import pcgen.facade.core.EquipmentFacade;
import pcgen.facade.core.EquipmentListFacade;
import pcgen.facade.core.EquipmentSetFacade;
import pcgen.gui2.facade.EquipNode;

/**
 * Gear: what the character owns (purchased), equipment sets (what is worn/carried where), and
 * funds. Buying raises no choosers unless the item needs customising; customising is declined.
 */
final class EquipmentRoutes
{
	private final Session s;
	private final CharacterRoutes characters;

	EquipmentRoutes(Session s, CharacterRoutes characters)
	{
		this.s = s;
		this.characters = characters;
	}

	void register(Router r)
	{
		r.get("/characters/{id}/equipment", this::view);
		r.put("/characters/{id}/equipment/scheme", this::setScheme);
		r.get("/characters/{id}/equipment/where", this::where);
		r.get("/characters/{id}/kits", this::kits);
		r.post("/characters/{id}/kits", this::applyKit);
		r.post("/characters/{id}/equipment/buy", this::buy);
		r.post("/characters/{id}/equipment/sell", this::sell);
		r.post("/characters/{id}/equipment/equip", this::equip);
		r.post("/characters/{id}/equipment/unequip", this::unequip);
		r.post("/characters/{id}/equipment-sets", this::createSet);
		r.put("/characters/{id}/equipment-sets/current", this::selectSet);
		r.delete("/characters/{id}/equipment-sets", this::deleteSet);
	}

	private Map<String, Object> item(CharacterFacade c, EquipmentFacade e, int quantity)
	{
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("weight", c.getInfoFactory().getWeight(e)); // each, in the game's weight unit (pounds)
		m.put("cost", c.getInfoFactory().getCost(e)); // each, in gold
		m.put("key", e.getKeyName());
		m.put("name", e.toString());
		m.put("quantity", quantity);
		m.put("types", e.getTypesForDisplay());
		return m;
	}

	private Object view(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("funds", CharacterView.text(c.getFundsRef()));
		m.put("wealth", CharacterView.text(c.getWealthRef()));
		m.put("load", CharacterView.text(c.getLoadRef()));
		m.put("carried", CharacterView.text(c.getCarriedWeightRef()));
		m.put("weightLimit", CharacterView.text(c.getWeightLimitRef()));
		m.put("allowDebt", c.isAllowDebt());
		m.put("autoResize", c.isAutoResize());
		m.put("buySellScheme", CharacterView.text(c.getGearBuySellRef()));
		EquipmentListFacade owned = c.getPurchasedEquipment();
		List<Map<String, Object>> purchased = new ArrayList<>();
		for (EquipmentFacade e : owned)
		{
			purchased.add(item(c, e, owned.getQuantity(e)));
		}
		m.put("purchased", purchased);
		m.put("sets", CharacterView.names(c.getEquipmentSets()));
		EquipmentSetFacade set = c.getEquipmentSetRef().get();
		// How much of each item is in the current set (worn, wielded or carried in a container), so the list can say so.
		Map<String, Integer> inSet = new LinkedHashMap<>();
		if (set != null)
		{
			for (EquipNode n : set.getNodes())
			{
				if (n.getNodeType() == EquipNode.NodeType.EQUIPMENT && n.getEquipment() != null)
				{
					inSet.merge(n.getEquipment().getKeyName(), set.getQuantity(n), Integer::sum);
				}
			}
		}
		for (Map<String, Object> row : purchased)
		{
			row.put("inSet", inSet.getOrDefault(String.valueOf(row.get("key")), 0));
		}
		m.put("loadInfo", loadInfo(c));
		m.put("currentSet", set == null ? null : CharacterView.text(set.getNameRef()));
		m.put("slots", set == null ? List.of() : nodes(set));
		return m;
	}

	/**
	 * How heavy the load is and where the bands lie: the weight carried, and the most each of light, medium and heavy
	 * allows (heavier than the last is overloaded). The engine's own figures: strength, size and bonuses all counted.
	 */
	private Map<String, Object> loadInfo(CharacterFacade c)
	{
		var pc = pcgen.gui2.facade.SidecarAccess.playerCharacter(c);
		var display = pc.getDisplay();
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("carried", display.totalWeight().doubleValue());
		m.put("unit", pcgen.core.Globals.getGameModeUnitSet().getWeightUnit().trim());
		List<Map<String, Object>> bands = new ArrayList<>();
		for (pcgen.util.enumeration.Load l : pcgen.util.enumeration.Load.values())
		{
			double limit = display.getLoadToken(l.toString());
			if (limit > 0)
			{
				Map<String, Object> b = new LinkedHashMap<>();
				b.put("name", pcgen.core.utils.CoreUtility.capitalizeFirstLetter(l.toString()));
				b.put("upTo", Double.parseDouble(pcgen.core.Globals.getGameModeUnitSet().displayWeightInUnitSet(limit)));
				bands.add(b);
			}
		}
		m.put("bands", bands);
		return m;
	}

	/** Where an owned item could be put in the current set: one entry per place (hand, body slot, container...). */
	private Object where(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		EquipmentSetFacade set = currentSet(c);
		EquipmentFacade e = ownedItem(c, q.requireStr("item"));
		String preferred = set.getPreferredLoc(e);
		List<EquipNode> nodes = new ArrayList<>();
		set.getNodes().forEach(nodes::add);
		List<Map<String, Object>> out = new ArrayList<>();
		java.util.Set<String> seen = new java.util.HashSet<>();
		for (int i = 0; i < nodes.size(); i++)
		{
			EquipNode n = nodes.get(i);
			if (n.getNodeType() == EquipNode.NodeType.EQUIPMENT || !set.canEquip(n, e))
			{
				continue;
			}
			String loc = set.getLocation(n);
			if (!seen.add(loc + "|" + n))
			{
				continue;
			}
			Map<String, Object> m = new LinkedHashMap<>();
			m.put("node", i);
			m.put("location", loc);
			m.put("name", n.toString());
			m.put("preferred", preferred != null && preferred.equalsIgnoreCase(loc));
			out.add(m);
		}
		return Map.of("item", e.toString(), "places", out);
	}

	private List<Map<String, Object>> nodes(EquipmentSetFacade set)
	{
		List<EquipNode> list = new ArrayList<>();
		set.getNodes().forEach(list::add);
		List<Map<String, Object>> out = new ArrayList<>();
		for (int i = 0; i < list.size(); i++)
		{
			EquipNode n = list.get(i);
			Map<String, Object> m = new LinkedHashMap<>();
			m.put("node", i);
			m.put("type", n.getNodeType().name());
			m.put("name", n.toString());
			m.put("parent", n.getParent() == null ? null : list.indexOf(n.getParent()));
			m.put("location", set.getLocation(n));
			if (n.getEquipment() != null)
			{
				m.put("equipment", n.getEquipment().toString());
				m.put("quantity", set.getQuantity(n));
			}
			out.add(m);
		}
		return out;
	}

	private EquipmentFacade datasetItem(CharacterFacade c, String name)
	{
		return Lookup.find(c.getDataSet().getEquipment(), name, "equipment", EquipmentFacade::getKeyName,
				Object::toString);
	}

	private EquipmentFacade ownedItem(CharacterFacade c, String name)
	{
		return Lookup.find(c.getPurchasedEquipment(), name, "equipment owned by this character",
				EquipmentFacade::getKeyName, Object::toString);
	}

	private int quantity(Request q)
	{
		int n = q.integer("quantity") == null ? 1 : q.requireInt("quantity");
		if (n < 1)
		{
			throw new ApiException(400, "quantity must be at least 1");
		}
		return n;
	}

	private Object buy(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		EquipmentFacade e = datasetItem(c, q.requireStr("item"));
		assertScheme(c);
		// With customize=true the engine opens the custom-equipment builder (202; see BuilderRoutes).
		// Like the GUI, buying is not blocked for unqualified items; the flag lets the client warn.
		boolean qualified = c.isQualifiedFor(e);
		// Funds are a BigDecimal for loaded characters but a plain Integer on a brand-new one: only print them.
		Object before = c.getFundsRef().get();
		c.addPurchasedEquipment(e, quantity(q), q.bool("customize", false), q.bool("free", false));
		return characters.changed(id, c, Map.of("fundsBefore", String.valueOf(before), "qualified", qualified));
	}

	/**
	 * The engine stores the buy and sell rates in one global setting, shared by every open character. Each
	 * character remembers its own price scheme, so put it back in force before any money changes hands.
	 */
	private void assertScheme(CharacterFacade c)
	{
		var scheme = c.getGearBuySellRef().get();
		if (scheme != null)
		{
			c.setGearBuySellRef(scheme);
		}
	}

	/** Prices: market price, character build (full price back), cashless (everything free), crafting... */
	private Object setScheme(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		var scheme = Lookup.find(s.dataSet().getGearBuySellSchemes(), q.requireStr("scheme"), "price scheme",
				Object::toString, Object::toString);
		c.setGearBuySellRef(scheme);
		return characters.changed(id, c, Map.of());
	}

	/** Kits available to this character (starting gold is one) and the ones already applied. */
	private Object kits(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		List<String> applied = new ArrayList<>();
		c.getKits().forEach(k -> applied.add(k.getDisplayName()));
		List<Map<String, Object>> available = new ArrayList<>();
		for (pcgen.core.Kit k : c.getAvailableKits())
		{
			Map<String, Object> m = new LinkedHashMap<>();
			m.put("key", k.getKeyName());
			m.put("name", k.getDisplayName());
			m.put("type", k.getType());
			m.put("applied", applied.contains(k.getDisplayName()));
			m.put("qualified", c.isQualifiedFor(k));
			available.add(m);
		}
		return Map.of("available", available, "applied", applied);
	}

	/** Applies a kit. Starting gold asks (through the chooser bridge) whether to roll, take the maximum or the average. */
	private Object applyKit(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		pcgen.core.Kit kit = Lookup.pObject(c.getAvailableKits(), q.requireStr("kit"), "kit");
		if (!c.isQualifiedFor(kit))
		{
			throw new ApiException(409, "this character does not qualify for " + kit.getDisplayName());
		}
		BigDecimal before = new BigDecimal(String.valueOf(c.getFundsRef().get()));
		s.ui.withRepeatedAnswers(() -> c.addKit(kit));
		return characters.changed(id, c, Map.of("fundsBefore", before.toPlainString(),
				"fundsAfter", String.valueOf(c.getFundsRef().get())));
	}

	private Object sell(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		EquipmentFacade e = ownedItem(c, q.requireStr("item"));
		assertScheme(c);
		c.removePurchasedEquipment(e, quantity(q), q.bool("free", false));
		return characters.changed(id, c, Map.of());
	}

	private EquipmentSetFacade currentSet(CharacterFacade c)
	{
		EquipmentSetFacade set = c.getEquipmentSetRef().get();
		if (set == null)
		{
			throw new ApiException(409, "character has no equipment set");
		}
		return set;
	}

	private Object equip(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		EquipmentSetFacade set = currentSet(c);
		EquipmentFacade e = ownedItem(c, q.requireStr("item"));
		List<EquipNode> nodes = new ArrayList<>();
		set.getNodes().forEach(nodes::add);
		EquipNode target = null;
		if (q.integer("node") != null)
		{
			int i = q.requireInt("node");
			if (i < 0 || i >= nodes.size())
			{
				throw new ApiException(400, "node must be between 0 and " + (nodes.size() - 1));
			}
			target = nodes.get(i);
		}
		else
		{
			// Without an explicit slot, take the first free slot that accepts the item. An explicit
			// location name narrows the choice; the set's preferred location is only a tie-breaker.
			String wanted = q.str("location");
			String preferred = set.getPreferredLoc(e);
			EquipNode fallback = null;
			for (EquipNode n : nodes)
			{
				if (n.getNodeType() == EquipNode.NodeType.EQUIPMENT || !set.canEquip(n, e))
				{
					continue;
				}
				String loc = set.getLocation(n);
				boolean named = wanted != null && (wanted.equalsIgnoreCase(loc) || wanted.equalsIgnoreCase(n.toString()));
				if (named || (wanted == null && preferred != null && preferred.equalsIgnoreCase(loc)))
				{
					target = n;
					break;
				}
				if (wanted == null && fallback == null)
				{
					fallback = n;
				}
			}
			if (target == null)
			{
				target = fallback;
			}
			if (target == null)
			{
				throw new ApiException(409, "no slot available for " + e + (wanted == null ? "" : " at " + wanted));
			}
		}
		if (set.addEquipment(target, e, quantity(q)) == null)
		{
			throw new ApiException(409, "could not equip " + e + ": " + s.ui.drain());
		}
		return characters.changed(id, c, Map.of("slots", nodes(set)));
	}

	private Object unequip(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		EquipmentSetFacade set = currentSet(c);
		List<EquipNode> nodes = new ArrayList<>();
		set.getNodes().forEach(nodes::add);
		int i = q.requireInt("node");
		if (i < 0 || i >= nodes.size() || nodes.get(i).getNodeType() != EquipNode.NodeType.EQUIPMENT)
		{
			throw new ApiException(400, "node must be the index of an equipped item (see GET equipment, slots)");
		}
		set.removeEquipment(nodes.get(i), quantity(q));
		return characters.changed(id, c, Map.of("slots", nodes(set)));
	}

	private Object createSet(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		EquipmentSetFacade set = c.createEquipmentSet(q.requireStr("name"));
		if (set == null)
		{
			throw new ApiException(409, "could not create equipment set: " + s.ui.drain());
		}
		return characters.changed(id, c, Map.of("created", CharacterView.text(set.getNameRef())));
	}

	private EquipmentSetFacade namedSet(CharacterFacade c, String name)
	{
		return Lookup.find(c.getEquipmentSets(), name, "equipment set", Object::toString, Object::toString);
	}

	private Object selectSet(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		c.setEquipmentSet(namedSet(c, q.requireStr("name")));
		return characters.changed(id, c, Map.of());
	}

	private Object deleteSet(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		c.deleteEquipmentSet(namedSet(c, q.requireStr("name")));
		return characters.changed(id, c, Map.of());
	}
}
