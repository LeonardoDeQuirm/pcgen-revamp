package pcgen.sidecar;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import pcgen.core.Campaign;
import pcgen.core.GameMode;
import pcgen.facade.core.CharacterFacade;
import pcgen.facade.core.DataSetFacade;
import pcgen.persistence.SourceFileLoader;

/**
 * State shared by all route groups: the loaded data set and the open characters. Everything
 * except {@link #characterIds()} must only be touched from the engine worker thread.
 */
final class Session
{
	final RecordingUIDelegate ui;
	private final Map<String, CharacterFacade> characters = Collections.synchronizedMap(new LinkedHashMap<>());
	GameMode gameMode;
	List<Campaign> campaigns;
	SourceFileLoader loader;

	Session(RecordingUIDelegate ui)
	{
		this.ui = ui;
	}

	DataSetFacade dataSet()
	{
		return loader.getDataSetFacade();
	}

	List<String> campaignNames()
	{
		return campaigns.stream().map(Campaign::getKeyName).toList();
	}

	CharacterFacade character(String id)
	{
		CharacterFacade c = characters.get(id);
		if (c == null)
		{
			throw new ApiException(404, "no open character: " + id);
		}
		return c;
	}

	boolean isOpen(String id)
	{
		return characters.containsKey(id);
	}

	void put(String id, CharacterFacade c)
	{
		characters.put(id, c);
	}

	void remove(String id)
	{
		characters.remove(id);
	}

	/** Safe from any thread. */
	List<String> characterIds()
	{
		synchronized (characters)
		{
			return new ArrayList<>(characters.keySet());
		}
	}

	Map<String, CharacterFacade> all()
	{
		return characters;
	}

	/** A short unused id derived from a base name, e.g. "Bob" then "Bob-2". */
	String freshId(String base)
	{
		String clean = base.replaceAll("[^A-Za-z0-9_.-]+", "_");
		if (clean.isEmpty())
		{
			clean = "character";
		}
		String id = clean;
		for (int n = 2; characters.containsKey(id); n++)
		{
			id = clean + "-" + n;
		}
		return id;
	}
}
