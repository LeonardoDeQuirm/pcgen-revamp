package pcgen.gui2.facade;

import pcgen.core.PlayerCharacter;
import pcgen.facade.core.CharacterFacade;

/**
 * Lives in the engine's package only to reach {@code CharacterFacadeImpl.getTheCharacter()}, which is
 * package-private. The facades don't expose per-level spell slots, but the character underneath does.
 * No engine source is changed.
 */
public final class SidecarAccess
{
	private SidecarAccess()
	{
	}

	public static PlayerCharacter playerCharacter(CharacterFacade c)
	{
		return ((CharacterFacadeImpl) c).getTheCharacter();
	}

	// ---- GM awards: PCGen's own mechanism (ability category "GM Awards") for handing out feats and feat slots ----

	/** The award that grants a feat without checking prerequisites; each selection is one feat. */
	public static final String FEAT_AWARD = "Add a Feat Ignoring Restrictions";
	/** The award that adds one feat slot; each selection is one slot. */
	public static final String SLOT_AWARD = "+1 Bonus Feat";

	/** The award that teaches a language; each selection is one language. */
	public static final String LANGUAGE_AWARD = "Add Language";

	/** The "GM Awards" ability category, or null when the game has none. */
	public static pcgen.core.AbilityCategory awardsCategory(CharacterFacade c)
	{
		for (pcgen.core.AbilityCategory k : c.getDataSet().getAbilities().getKeys())
		{
			if ("GM Awards".equals(k.getKeyName()))
			{
				return k;
			}
		}
		return null;
	}

	/** What the character has been given through one award, as the engine stores it (one entry per selection). */
	public static java.util.List<String> awardSelections(CharacterFacade c, String awardKey)
	{
		java.util.List<String> out = new java.util.ArrayList<>();
		pcgen.core.AbilityCategory cat = awardsCategory(c);
		if (cat == null)
		{
			return out;
		}
		PlayerCharacter pc = playerCharacter(c);
		for (pcgen.cdom.content.CNAbility cna : pc.getPoolAbilities(cat, pcgen.cdom.enumeration.Nature.NORMAL))
		{
			if (cna.getAbility().getKeyName().equals(awardKey))
			{
				out.addAll(pc.getAssociationList(cna));
			}
		}
		return out;
	}

	/** The feat an award selection stands for ("CATEGORY=FEAT|Dodge" is Dodge; a feat with a choice keeps only the feat). */
	static String awardedFeat(String selection)
	{
		String[] p = selection.split("\\||&pipe;");
		return p.length >= 2 && p[0].startsWith("CATEGORY=") ? p[1] : p[0];
	}

	/** An award selection as a person would read it: "CATEGORY=FEAT|Weapon Focus|Dagger" is "Weapon Focus (Dagger)". */
	public static String awardChoiceText(String selection)
	{
		String[] p = selection.split("\\||&pipe;");
		if (p.length >= 2 && p[0].startsWith("CATEGORY="))
		{
			return p.length >= 3 ? p[1] + " (" + p[2] + ")" : p[1];
		}
		return selection;
	}

	/** The feats handed out through the award, as category key plus feat key (the form CharacterView looks up). */
	public static java.util.Set<String> gmGranted(CharacterFacade c)
	{
		java.util.Set<String> out = new java.util.LinkedHashSet<>();
		for (String sel : awardSelections(c, FEAT_AWARD))
		{
			out.add("FEAT|" + awardedFeat(sel));
		}
		return out;
	}

	/**
	 * Withdraws the feat(s) an award handed out. Removing the award's selection in the chooser only drops the award's record
	 * of it; the feat itself was granted to the character with the award as its source and stays until that grant is
	 * taken back. Feats restored from a saved file have no such grant and are removed as ordinary feats by the caller.
	 */
	public static void revokeAwardedFeat(CharacterFacade c, pcgen.core.Ability award, String featKey)
	{
		PlayerCharacter pc = playerCharacter(c);
		java.util.List<Object[]> grants = new java.util.ArrayList<>();
		// Only grants made by this award's own selector: the same feat can also come from a race, class or a person's choice.
		java.util.List<?> awardActors = award.getSafeListFor(pcgen.cdom.enumeration.ListKey.NEW_CHOOSE_ACTOR);
		try
		{
			// The facet keeps every grant together with what granted it, but only lets subclasses look.
			var direct = pcgen.cdom.facet.FacetLibrary.getFacet(pcgen.cdom.facet.DirectAbilityFacet.class);
			java.lang.reflect.Method getList = pcgen.cdom.facet.base.AbstractCNASEnforcingFacet.class.getDeclaredMethod("getList",
				pcgen.cdom.enumeration.CharID.class);
			getList.setAccessible(true);
			java.util.List<?> lists = (java.util.List<?>) getList.invoke(direct, pc.getCharID());
			for (Object list : lists == null ? java.util.List.of() : lists)
			{
				for (Object sourced : (java.util.List<?>) list)
				{
					java.lang.reflect.Field fc = sourced.getClass().getDeclaredField("cnas");
					java.lang.reflect.Field fs = sourced.getClass().getDeclaredField("source");
					fc.setAccessible(true);
					fs.setAccessible(true);
					pcgen.cdom.helper.CNAbilitySelection cnas = (pcgen.cdom.helper.CNAbilitySelection) fc.get(sourced);
					Object source = fs.get(sourced);
					if (cnas.getCNAbility().getAbility().getKeyName().equals(featKey)
						&& cnas.getCNAbility().getAbilityCategory().equals(pcgen.core.AbilityCategory.FEAT)
						&& awardActors.contains(source))
					{
						grants.add(new Object[] {cnas, source});
					}
				}
			}
		}
		catch (ReflectiveOperationException e)
		{
			throw new IllegalStateException("cannot look up what granted the feat", e);
		}
		for (Object[] g : grants)
		{
			pc.removeAbility((pcgen.cdom.helper.CNAbilitySelection) g[0], award, g[1]);
		}
		pc.calcActiveBonuses();
		refreshAbilities(c);
	}

	/** How many extra feat slots the GM has handed out. */
	public static int gmBonusSlots(CharacterFacade c)
	{
		return awardSelections(c, SLOT_AWARD).size();
	}

	/** Rebuilds the facade's ability lists after the character was changed underneath it. */
	private static void refreshAbilities(CharacterFacade c)
	{
		try
		{
			java.lang.reflect.Field f = CharacterFacadeImpl.class.getDeclaredField("characterAbilities");
			f.setAccessible(true);
			((CharacterAbilities) f.get(c)).rebuildAbilityLists();
		}
		catch (ReflectiveOperationException e)
		{
			throw new IllegalStateException("cannot refresh the ability lists", e);
		}
	}

	// ---- equipment: notes, charges and customising what the character already owns ----

	/** The player's own note on an owned item (null if none). */
	public static String equipmentNote(pcgen.facade.core.EquipmentFacade e)
	{
		return e instanceof pcgen.core.Equipment eq ? eq.getNote() : null;
	}

	/** Sets the note on an owned item. The engine writes it into the character file unescaped, so keep it one plain line. */
	public static void setEquipmentNote(CharacterFacade c, pcgen.facade.core.EquipmentFacade e, String note)
	{
		if (e instanceof pcgen.core.Equipment eq)
		{
			String clean = note == null ? "" : note.replace('|', '/').replace('\r', ' ').replace('\n', ' ').trim();
			eq.setNote(clean.isEmpty() ? null : clean);
			playerCharacter(c).setDirty(true);
		}
	}

	/** {remaining, max} charges of an owned item (a wand), or null when it does not use charges. */
	public static int[] charges(pcgen.facade.core.EquipmentFacade e)
	{
		if (e instanceof pcgen.core.Equipment eq)
		{
			int max = eq.getMaxCharges();
			int remaining = eq.getRemainingCharges();
			if (max > 0 || remaining >= 0)
			{
				return new int[] {Math.max(remaining, 0), max};
			}
		}
		return null;
	}

	public static void setCharges(CharacterFacade c, pcgen.facade.core.EquipmentFacade e, int remaining)
	{
		if (e instanceof pcgen.core.Equipment eq)
		{
			eq.setRemainingCharges(remaining);
			playerCharacter(c).setDirty(true);
			playerCharacter(c).setCalcEquipmentList();
		}
	}

	/** What an upgrade to an owned item came to. */
	public record Upgrade(String newName, java.math.BigDecimal perItem, java.math.BigDecimal charged)
	{
	}

	/**
	 * Customises items the character already owns: opens the item builder on a copy, and when it is finished swaps
	 * quantity of the old item for the new one (the note carries over). With charge the character pays the price
	 * difference at the current buy rate (nothing if the new item is not worth more); without it the upgrade is free.
	 * Returns null when the builder was cancelled; throws when the character cannot afford the upgrade.
	 */
	public static Upgrade customizeOwned(CharacterFacade c, pcgen.facade.core.EquipmentFacade owned, int quantity,
		boolean charge)
	{
		PlayerCharacter pc = playerCharacter(c);
		pcgen.core.Equipment old = (pcgen.core.Equipment) owned;
		pcgen.core.Equipment fresh = old.clone();
		if (!fresh.containsKey(pcgen.cdom.enumeration.ObjectKey.BASE_ITEM))
		{
			fresh.put(pcgen.cdom.enumeration.ObjectKey.BASE_ITEM, pcgen.cdom.reference.CDOMDirectSingleRef.getRef(old));
		}
		pcgen.facade.core.UIDelegate ui = c.getUIDelegate();
		EquipmentBuilderFacadeImpl builder = new EquipmentBuilderFacadeImpl(fresh, pc, ui);
		if (ui.showCustomEquipDialog(c, builder) == pcgen.facade.core.UIDelegate.CustomEquipResult.CANCELLED)
		{
			return null;
		}
		java.math.BigDecimal perItem = fresh.getCost(pc).subtract(old.getCost(pc)).max(java.math.BigDecimal.ZERO);
		java.math.BigDecimal charged = java.math.BigDecimal.ZERO;
		if (charge && perItem.signum() > 0)
		{
			java.math.BigDecimal rate = ((pcgen.core.GearBuySellScheme) c.getGearBuySellRef().get()).getBuyRate();
			charged = perItem.multiply(java.math.BigDecimal.valueOf(quantity)).multiply(rate)
				.multiply(new java.math.BigDecimal("0.01"));
			java.math.BigDecimal funds = new java.math.BigDecimal(String.valueOf(c.getFundsRef().get()));
			if (!c.isAllowDebt() && charged.compareTo(funds) > 0)
			{
				throw new IllegalStateException("the upgrade costs " + charged.stripTrailingZeros().toPlainString()
					+ " gp and the character has " + funds.stripTrailingZeros().toPlainString() + " gp");
			}
		}
		String note = old.getNote();
		c.getDataSet().addEquipment(fresh);
		c.removePurchasedEquipment(old, quantity, true);
		c.addPurchasedEquipment(fresh, quantity, false, true);
		pcgen.core.Equipment now = pc.getEquipmentNamed(fresh.getName());
		if (now != null && note != null && now.getNote() == null)
		{
			now.setNote(note);
		}
		if (charged.signum() > 0)
		{
			// setFunds (not adjustFunds): a brand-new character's funds are held as a whole number, which adjustFunds
			// cannot add to.
			c.setFunds(new java.math.BigDecimal(String.valueOf(c.getFundsRef().get())).subtract(charged));
		}
		pc.setDirty(true);
		return new Upgrade(fresh.getName(), perItem, charged);
	}

	/** The engine's own spell behind a spell facade (null if it is some other kind). */
	public static pcgen.core.spell.Spell spellOf(pcgen.facade.core.SpellFacade f)
	{
		return f instanceof SpellFacadeImplem s ? s.getSpell() : null;
	}

	/** How this spell is held: its level before and after metamagic, and which metamagic feats were applied. */
	public static pcgen.core.character.SpellInfo spellInfoOf(pcgen.facade.core.SpellFacade f)
	{
		return f instanceof SpellFacadeImplem s ? s.getSpellInfo() : null;
	}
}
