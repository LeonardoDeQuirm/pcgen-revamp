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
