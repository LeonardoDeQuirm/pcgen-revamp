package pcgen.sidecar;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import pcgen.core.EquipmentModifier;
import pcgen.core.SizeAdjustment;
import pcgen.facade.core.EquipmentBuilderFacade;
import pcgen.facade.core.EquipmentBuilderFacade.EquipmentHead;
import pcgen.facade.core.UIDelegate.CustomEquipResult;
import pcgen.facade.util.ListFacade;

/**
 * The custom-equipment builder: enchantments, materials, size, name, cost and so on. It only exists
 * while the engine is parked in it, which happens when a purchase is made with {@code customize=true}
 * (the call returns 202 with {@code pendingBuilder}). Edits run on the engine thread via the parked
 * session. Finish with {@code /builder/commit} (add to the item list, optionally also buy) or
 * {@code /builder/cancel}.
 */
final class BuilderRoutes
{
	/** Returned by {@link #handle} when the session ended and the caller should collect the operation's result. */
	static final Object FINISHED = new Object();

	private BuilderRoutes()
	{
	}

	static Map<String, Object> describe(RecordingUIDelegate.PendingBuilder pb)
	{
		EquipmentBuilderFacade b = pb.builder;
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("id", pb.id);
		m.put("baseItem", b.getBaseItemName());
		m.put("name", String.valueOf(b.getEquipment()));
		m.put("weapon", b.isWeapon());
		m.put("damage", b.isWeapon() ? b.getDamage() : null);
		m.put("resizable", b.isResizable());
		m.put("size", CharacterView.text(b.getSizeRef()));
		Map<String, Object> heads = new LinkedHashMap<>();
		for (EquipmentHead h : b.getEquipmentHeads())
		{
			Map<String, Object> hm = new LinkedHashMap<>();
			hm.put("applied", CharacterView.names(b.getSelectedList(h)));
			hm.put("availableCount", b.getAvailList(h).getSize());
			heads.put(h.name(), hm);
		}
		m.put("heads", heads);
		return m;
	}

	private static EquipmentHead head(Request q)
	{
		String h = q.str("head");
		if (h == null || h.isBlank() || h.equalsIgnoreCase("primary"))
		{
			return EquipmentHead.PRIMARY;
		}
		if (h.equalsIgnoreCase("secondary"))
		{
			return EquipmentHead.SECONDARY;
		}
		throw new ApiException(400, "head must be PRIMARY or SECONDARY");
	}

	private static EquipmentModifier modifier(ListFacade<EquipmentModifier> list, String name, String what)
	{
		return Lookup.pObject(list, name, what);
	}

	/**
	 * Handles any /builder request. Runs on an HTTP thread; engine access goes through the session.
	 *
	 * @return a response body, or {@link #FINISHED}
	 */
	static Object handle(RecordingUIDelegate.PendingBuilder pb, Request q, Session session) throws Exception
	{
		if (pb == null)
		{
			throw new ApiException(404, "no custom equipment builder is open (buy an item with customize=true)");
		}
		String path = q.path();
		String method = q.method();
		EquipmentBuilderFacade b = pb.builder;

		if (path.equals("/builder") && method.equals("GET"))
		{
			return pb.runOnEngine(() -> describe(pb));
		}
		if (path.equals("/builder") && method.equals("PATCH"))
		{
			return pb.runOnEngine(() -> {
				List<String> rejected = new ArrayList<>();
				if (q.has("name") && !b.setName(q.str("name")))
				{
					rejected.add("name");
				}
				if (q.has("sprop") && !b.setSProp(q.str("sprop")))
				{
					rejected.add("sprop");
				}
				if (q.has("cost") && !b.setCost(q.str("cost")))
				{
					rejected.add("cost");
				}
				if (q.has("weight") && !b.setWeight(q.str("weight")))
				{
					rejected.add("weight");
				}
				if (q.has("damage") && !b.setDamage(q.str("damage")))
				{
					rejected.add("damage");
				}
				if (q.has("size"))
				{
					if (!b.isResizable())
					{
						throw new ApiException(409, "this item cannot be resized");
					}
					SizeAdjustment size = Lookup.pObject(session.dataSet().getSizes(), q.requireStr("size"), "size");
					b.setSize(size);
				}
				Map<String, Object> m = describe(pb);
				m.put("rejected", rejected);
				return m;
			});
		}
		if (path.equals("/builder/modifiers") && method.equals("GET"))
		{
			return pb.runOnEngine(() -> {
				ListFacade<EquipmentModifier> list =
						q.bool("applied", false) ? b.getSelectedList(head(q)) : b.getAvailList(head(q));
				String needle = q.str("q") == null ? "" : q.str("q").toLowerCase();
				int limit = q.integer("limit") == null ? 100 : q.requireInt("limit");
				List<Map<String, Object>> out = new ArrayList<>();
				int total = 0;
				for (EquipmentModifier em : list)
				{
					if (!needle.isEmpty() && !em.getDisplayName().toLowerCase().contains(needle)
							&& !em.getKeyName().toLowerCase().contains(needle))
					{
						continue;
					}
					total++;
					if (out.size() < limit)
					{
						out.add(Map.of("key", em.getKeyName(), "name", em.getDisplayName()));
					}
				}
				return Map.of("total", total, "items", out);
			});
		}
		if (path.equals("/builder/modifiers") && method.equals("POST"))
		{
			return pb.runOnEngine(() -> {
				EquipmentModifier em = modifier(b.getAvailList(head(q)), q.requireStr("name"), "available modifier");
				if (!b.addModToEquipment(em, head(q)))
				{
					throw new ApiException(409, "modifier could not be applied: " + em.getKeyName());
				}
				return describe(pb);
			});
		}
		if (path.equals("/builder/modifiers") && method.equals("DELETE"))
		{
			return pb.runOnEngine(() -> {
				EquipmentModifier em = modifier(b.getSelectedList(head(q)), q.requireStr("name"), "applied modifier");
				if (!b.removeModFromEquipment(em, head(q)))
				{
					throw new ApiException(409, "modifier could not be removed: " + em.getKeyName());
				}
				return describe(pb);
			});
		}
		if (path.equals("/builder/commit") && method.equals("POST"))
		{
			// purchase=true adds the item to the character as well as to the item list.
			pb.finish(q.bool("purchase", true) ? CustomEquipResult.PURCHASE : CustomEquipResult.OK);
			return FINISHED;
		}
		if (path.equals("/builder/cancel") && method.equals("POST"))
		{
			pb.finish(CustomEquipResult.CANCELLED);
			return FINISHED;
		}
		throw new ApiException(404, "no builder route for " + method + " " + path);
	}
}
