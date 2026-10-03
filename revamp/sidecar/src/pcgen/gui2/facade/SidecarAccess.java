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
}
