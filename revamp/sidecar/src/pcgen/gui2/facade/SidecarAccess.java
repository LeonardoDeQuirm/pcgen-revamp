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

	/**
	 * Adds an ability the way a GM hands one out: as a saved VIRTUAL ability, which the engine does not check
	 * against prerequisites, does not count against the category's selections, and writes to the character file.
	 * Abilities that ask for a choice (a weapon for Weapon Focus) ask through the usual chooser.
	 */
	public static void addGmAbility(CharacterFacade c, pcgen.core.AbilityCategory cat, pcgen.core.Ability ability)
	{
		PlayerCharacter pc = playerCharacter(c);
		pc.setDirty(true);
		pc.getSpellList();
		pcgen.cdom.content.CNAbility cna = pcgen.cdom.content.CNAbilityFactory.getCNAbility(cat, pcgen.cdom.enumeration.Nature.VIRTUAL, ability);
		if (!ability.getSafe(pcgen.cdom.enumeration.ObjectKey.MULTIPLE_ALLOWED))
		{
			pc.addSavedAbility(new pcgen.cdom.helper.CNAbilitySelection(cna), pcgen.cdom.base.UserSelection.getInstance(),
				pcgen.cdom.base.UserSelection.getInstance());
		}
		var manager = pcgen.core.chooser.ChooserUtilities.getConfiguredController(cna, pc, cat, new java.util.ArrayList<>());
		if (manager != null)
		{
			// The engine lets a multiple-choice ability make as many choices as the category has free selections
			// (none left means none allowed). A GM's gift does not use a selection, so lend it one for the choosing
			// and put the count back exactly as it was.
			java.math.BigDecimal original = pc.getAvailableAbilityPool(cat);
			try
			{
				if (original.compareTo(java.math.BigDecimal.ONE) < 0)
				{
					pc.adjustAbilities(cat, java.math.BigDecimal.ONE.subtract(original));
				}
				chooseAndSave(pc, cna, manager);
			}
			finally
			{
				pc.adjustAbilities(cat, original.subtract(pc.getAvailableAbilityPool(cat)));
			}
		}
		pc.getSpellList();
		pc.calcActiveBonuses();
		refreshAbilities(c);
	}

	private static <T> void chooseAndSave(PlayerCharacter pc, pcgen.cdom.content.CNAbility cna,
		pcgen.core.chooser.ChoiceManagerList<T> manager)
	{
		java.util.ArrayList<T> available = new java.util.ArrayList<>();
		java.util.ArrayList<T> selected = new java.util.ArrayList<>();
		manager.getChoices(pc, available, selected);
		if (available.isEmpty() && selected.isEmpty())
		{
			return;
		}
		java.util.List<T> before = new java.util.ArrayList<>(selected);
		java.util.List<T> chosen = manager.doChooser(pc, available, selected, new java.util.ArrayList<>());
		chosen.removeAll(before);
		for (T pick : chosen)
		{
			pc.addSavedAbility(new pcgen.cdom.helper.CNAbilitySelection(cna, manager.encodeChoice(pick)),
				pcgen.cdom.base.UserSelection.getInstance(), pcgen.cdom.base.UserSelection.getInstance());
		}
	}

	/** Takes back a GM-granted ability (every selection of it). False if the character has none. */
	public static boolean removeGmAbility(CharacterFacade c, pcgen.core.AbilityCategory cat, pcgen.core.Ability ability)
	{
		PlayerCharacter pc = playerCharacter(c);
		boolean any = false;
		for (pcgen.cdom.helper.CNAbilitySelection cnas : new java.util.ArrayList<>(pc.getSaveAbilities()))
		{
			pcgen.cdom.content.CNAbility cna = cnas.getCNAbility();
			if (cna.getAbilityCategory().equals(cat) && cna.getAbility().equals(ability))
			{
				pc.removeSavedAbility(cnas, pcgen.cdom.base.UserSelection.getInstance(),
					pcgen.cdom.base.UserSelection.getInstance());
				any = true;
			}
		}
		if (any)
		{
			pc.setDirty(true);
			pc.calcActiveBonuses();
			refreshAbilities(c);
		}
		return any;
	}

	/** The abilities a GM handed out (saved virtual abilities), as category key plus ability key. */
	public static java.util.Set<String> gmGranted(CharacterFacade c)
	{
		java.util.Set<String> out = new java.util.LinkedHashSet<>();
		for (pcgen.cdom.helper.CNAbilitySelection cnas : playerCharacter(c).getSaveAbilities())
		{
			pcgen.cdom.content.CNAbility cna = cnas.getCNAbility();
			if (cna.getNature() == pcgen.cdom.enumeration.Nature.VIRTUAL)
			{
				out.add(cna.getAbilityCategory().getKeyName() + "|" + cna.getAbility().getKeyName());
			}
		}
		return out;
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
