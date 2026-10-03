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
		r.post("/characters/{id}/equipment/buy", this::buy);
		r.post("/characters/{id}/equipment/sell", this::sell);
		r.post("/characters/{id}/equipment/equip", this::equip);
		r.post("/characters/{id}/equipment/unequip", this::unequip);
		r.post("/characters/{id}/equipment-sets", this::createSet);
		r.put("/characters/{id}/equipment-sets/current", this::selectSet);
		r.delete("/characters/{id}/equipment-sets", this::deleteSet);
	}

	private Map<String, Object> item(EquipmentFacade e, int quantity)
	{
		Map<String, Object> m = new LinkedHashMap<>();
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
			purchased.add(item(e, owned.getQuantity(e)));
		}
		m.put("purchased", purchased);
		m.put("sets", CharacterView.names(c.getEquipmentSets()));
		EquipmentSetFacade set = c.getEquipmentSetRef().get();
		m.put("currentSet", set == null ? null : CharacterView.text(set.getNameRef()));
		m.put("slots", set == null ? List.of() : nodes(set));
		return m;
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
		// With customize=true the engine opens the custom-equipment builder (202; see BuilderRoutes).
		// Like the GUI, buying is not blocked for unqualified items; the flag lets the client warn.
		boolean qualified = c.isQualifiedFor(e);
		BigDecimal before = c.getFundsRef().get();
		c.addPurchasedEquipment(e, quantity(q), q.bool("customize", false), q.bool("free", false));
		return characters.changed(id, c, Map.of("fundsBefore", String.valueOf(before), "qualified", qualified));
	}

	private Object sell(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		EquipmentFacade e = ownedItem(c, q.requireStr("item"));
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
