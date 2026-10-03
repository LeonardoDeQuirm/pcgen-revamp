package pcgen.system;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import pcgen.gui2.UIPropertyContext;
import pcgen.util.Logging;

/**
 * Lives in the engine's package only to reach package-private settings APIs, so the engine
 * source stays untouched. Everything else in the sidecar uses public API.
 */
public final class SidecarBootstrap
{
	private SidecarBootstrap()
	{
	}

	/**
	 * Equivalent of {@code Main.main}'s config setup plus {@code Main.loadProperties(false)},
	 * which can't be called directly because it reads Main's private command-line state.
	 */
	public static void initSettings(String settingsDir)
	{
		PropertyContextFactory configFactory = new PropertyContextFactory(settingsDir);
		configFactory.registerAndLoadPropertyContext(ConfigurationSettings.getInstance());

		PropertyContextFactory.setDefaultFactory(settingsDir);
		PropertyContextFactory defaultFactory = PropertyContextFactory.getDefaultFactory();
		PropertyContext settings = PCGenSettings.getInstance();
		defaultFactory.registerPropertyContext(settings);
		defaultFactory.registerPropertyContext(UIPropertyContext.getInstance());
		defaultFactory.registerPropertyContext(LegacySettings.getInstance());
		defaultFactory.loadPropertyContexts();
		try
		{
			Files.createDirectories(Path.of(settings.getProperty(PCGenSettings.PCG_SAVE_PATH)));
		}
		catch (IOException e)
		{
			Logging.errorPrint("Unable to create save path", e);
		}
	}
}
