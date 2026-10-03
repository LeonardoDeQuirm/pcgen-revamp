package pcgen.sidecar;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import pcgen.cdom.enumeration.BiographyField;
import pcgen.cdom.enumeration.PCStringKey;
import pcgen.cdom.util.CControl;
import pcgen.core.ChronicleEntry;
import pcgen.core.Globals;
import pcgen.core.NoteItem;
import pcgen.facade.core.CharacterFacade;
import pcgen.facade.core.DescriptionFacade;
import pcgen.facade.util.ListFacade;
import pcgen.facade.util.ReferenceFacade;
import pcgen.facade.util.WriteableReferenceFacade;
import pcgen.gui2.facade.UnitSetWrappedReference;
import pcgen.gui2.util.CoreInterfaceUtilities;

/**
 * The "who is this person" parts of a character: biography fields, appearance, free-form notes
 * and the campaign chronicle. Notes and chronicle entries are addressed by their position in the
 * list returned by the matching GET, which stays stable until something is added or removed.
 */
final class DescriptionRoutes
{
	/** API name, engine field and the attribute key the engine stores it under. */
	private record Field(String api, BiographyField field, PCStringKey key)
	{
	}

	private static final List<Field> TEXT_FIELDS = List.of(
			new Field("speechPattern", BiographyField.SPEECH_PATTERN, PCStringKey.SPEECHTENDENCY),
			new Field("birthday", BiographyField.BIRTHDAY, PCStringKey.BIRTHDAY),
			new Field("location", BiographyField.LOCATION, PCStringKey.LOCATION),
			new Field("city", BiographyField.CITY, PCStringKey.CITY),
			new Field("birthplace", BiographyField.BIRTHPLACE, PCStringKey.BIRTHPLACE),
			new Field("personalityTrait1", BiographyField.PERSONALITY_TRAIT_1, PCStringKey.PERSONALITY1),
			new Field("personalityTrait2", BiographyField.PERSONALITY_TRAIT_2, PCStringKey.PERSONALITY2),
			new Field("phobias", BiographyField.PHOBIAS, PCStringKey.PHOBIAS),
			new Field("interests", BiographyField.INTERESTS, PCStringKey.INTERESTS),
			new Field("catchPhrase", BiographyField.CATCH_PHRASE, PCStringKey.CATCHPHRASE));

	private final Session s;
	private final CharacterRoutes characters;

	DescriptionRoutes(Session s, CharacterRoutes characters)
	{
		this.s = s;
		this.characters = characters;
	}

	void register(Router r)
	{
		r.get("/characters/{id}/biography", q -> biography(s.character(q.param("id"))));
		r.patch("/characters/{id}/biography", this::patchBiography);

		r.get("/characters/{id}/notes", q -> notes(s.character(q.param("id"))));
		r.post("/characters/{id}/notes", this::addNote);
		r.patch("/characters/{id}/notes/{index}", this::patchNote);
		r.delete("/characters/{id}/notes/{index}", this::deleteNote);

		r.get("/characters/{id}/chronicle", q -> chronicle(s.character(q.param("id"))));
		r.post("/characters/{id}/chronicle", this::addChronicle);
		r.patch("/characters/{id}/chronicle/{index}", this::patchChronicle);
		r.delete("/characters/{id}/chronicle/{index}", this::deleteChronicle);
	}

	// ---- biography and appearance ----

	/** Height lives in an engine "channel", in inches; the UI works in the game mode's unit. */
	private WriteableReferenceFacade<Number> heightRef(CharacterFacade c)
	{
		try
		{
			WriteableReferenceFacade<Number> inches =
					CoreInterfaceUtilities.getReferenceFacade(c.getCharID(), CControl.HEIGHTINPUT);
			return inches == null ? null : UnitSetWrappedReference.getReference(inches,
					Globals.getGameModeUnitSet()::convertHeightToUnitSet,
					Globals.getGameModeUnitSet()::convertHeightFromUnitSet);
		}
		catch (RuntimeException e)
		{
			return null;
		}
	}

	private WriteableReferenceFacade<String> hairStyleRef(CharacterFacade c)
	{
		try
		{
			return CoreInterfaceUtilities.getReferenceFacade(c.getCharID(), CControl.HAIRSTYLEINPUT);
		}
		catch (RuntimeException e)
		{
			return null;
		}
	}

	private Map<String, Object> biography(CharacterFacade c)
	{
		DescriptionFacade d = c.getDescriptionFacade();
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("skinColor", CharacterView.text(c.getSkinColorRef()));
		m.put("hairColor", CharacterView.text(c.getHairColorRef()));
		m.put("eyeColor", CharacterView.text(c.getEyeColorRef()));
		ReferenceFacade<String> hair = null;
		try
		{
			hair = d.getBiographyField(BiographyField.HAIR_STYLE);
		}
		catch (UnsupportedOperationException e)
		{
			// not available in this game mode
		}
		m.put("hairStyle", CharacterView.text(hair));
		WriteableReferenceFacade<Number> height = heightRef(c);
		m.put("height", height == null ? null : height.get());
		m.put("heightUnit", c.getDataSet().getGameMode().getHeightUnit());
		m.put("weight", c.getWeightRef().get());
		m.put("weightUnit", c.getDataSet().getGameMode().getWeightUnit());
		for (Field f : TEXT_FIELDS)
		{
			m.put(f.api(), CharacterView.text(d.getBiographyField(f.field())));
		}
		m.put("region", CharacterView.text(d.getBiographyField(BiographyField.REGION)));
		return m;
	}

	private Object patchBiography(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		DescriptionFacade d = c.getDescriptionFacade();
		for (Field f : TEXT_FIELDS)
		{
			if (q.has(f.api()))
			{
				d.setBiographyField(f.field(), f.key(), q.str(f.api()) == null ? "" : q.str(f.api()));
			}
		}
		if (q.has("skinColor"))
		{
			c.setSkinColor(q.str("skinColor"));
		}
		if (q.has("hairColor"))
		{
			c.setHairColor(q.str("hairColor"));
		}
		if (q.has("eyeColor"))
		{
			c.setEyeColor(q.str("eyeColor"));
		}
		if (q.has("weight"))
		{
			c.setWeight(q.requireInt("weight"));
		}
		if (q.has("height"))
		{
			WriteableReferenceFacade<Number> height = heightRef(c);
			if (height == null)
			{
				throw new ApiException(409, "this game mode has no height field");
			}
			height.set(q.requireInt("height"));
		}
		if (q.has("hairStyle"))
		{
			WriteableReferenceFacade<String> hair = hairStyleRef(c);
			if (hair == null)
			{
				throw new ApiException(409, "this game mode has no hair style field");
			}
			hair.set(q.str("hairStyle"));
		}
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("biography", biography(c));
		m.put("messages", s.ui.drain());
		return m;
	}

	// ---- notes ----

	private List<NoteItem> noteList(CharacterFacade c)
	{
		List<NoteItem> out = new ArrayList<>();
		c.getDescriptionFacade().getNotes().forEach(out::add);
		return out;
	}

	private List<Map<String, Object>> notes(CharacterFacade c)
	{
		List<Map<String, Object>> out = new ArrayList<>();
		List<NoteItem> list = noteList(c);
		for (int i = 0; i < list.size(); i++)
		{
			NoteItem n = list.get(i);
			Map<String, Object> m = new LinkedHashMap<>();
			m.put("index", i);
			m.put("id", n.getId());
			m.put("parentId", n.getParentId());
			m.put("name", n.getName());
			m.put("text", n.getValue());
			// Built-in notes (Biography, Description, ...) can be edited but not renamed or deleted.
			m.put("builtIn", n.getPCStringKey().isPresent());
			out.add(m);
		}
		return out;
	}

	private NoteItem note(CharacterFacade c, String index)
	{
		List<NoteItem> list = noteList(c);
		int i;
		try
		{
			i = Integer.parseInt(index);
		}
		catch (NumberFormatException e)
		{
			throw new ApiException(400, "note index must be an integer");
		}
		if (i < 0 || i >= list.size())
		{
			throw new ApiException(404, "no note at index " + i + " (there are " + list.size() + ")");
		}
		return list.get(i);
	}

	private Object notesChanged(String id, CharacterFacade c, Map<String, Object> extra)
	{
		Map<String, Object> m = new LinkedHashMap<>(extra);
		m.put("notes", notes(c));
		m.put("messages", s.ui.drain());
		return m;
	}

	private Object addNote(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		DescriptionFacade d = c.getDescriptionFacade();
		int before = noteList(c).size();
		d.addNewNote();
		List<NoteItem> after = noteList(c);
		if (after.size() != before + 1)
		{
			throw new ApiException(500, "engine did not add a note");
		}
		NoteItem created = after.get(after.size() - 1);
		if (q.has("name"))
		{
			d.renameNote(created, q.str("name"));
		}
		if (q.has("text"))
		{
			d.setNote(created, q.str("text"));
		}
		return notesChanged(id, c, Map.of("created", before));
	}

	private Object patchNote(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		NoteItem n = note(c, q.param("index"));
		DescriptionFacade d = c.getDescriptionFacade();
		if (q.has("name"))
		{
			if (n.getPCStringKey().isPresent())
			{
				throw new ApiException(409, "built-in notes cannot be renamed");
			}
			d.renameNote(n, q.str("name"));
		}
		if (q.has("text"))
		{
			d.setNote(n, q.str("text") == null ? "" : q.str("text"));
		}
		return notesChanged(id, c, Map.of());
	}

	private Object deleteNote(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		NoteItem n = note(c, q.param("index"));
		if (n.getPCStringKey().isPresent())
		{
			throw new ApiException(409, "built-in notes cannot be deleted");
		}
		c.getDescriptionFacade().deleteNote(n);
		return notesChanged(id, c, Map.of());
	}

	// ---- chronicle ----

	private List<ChronicleEntry> entryList(CharacterFacade c)
	{
		List<ChronicleEntry> out = new ArrayList<>();
		ListFacade<ChronicleEntry> list = c.getDescriptionFacade().getChronicleEntries();
		list.forEach(out::add);
		return out;
	}

	private List<Map<String, Object>> chronicle(CharacterFacade c)
	{
		List<Map<String, Object>> out = new ArrayList<>();
		List<ChronicleEntry> list = entryList(c);
		for (int i = 0; i < list.size(); i++)
		{
			ChronicleEntry e = list.get(i);
			Map<String, Object> m = new LinkedHashMap<>();
			m.put("index", i);
			m.put("campaign", e.getCampaign());
			m.put("adventure", e.getAdventure());
			m.put("party", e.getParty());
			m.put("date", e.getDate());
			m.put("xp", e.getXpField());
			m.put("gm", e.getGmField());
			m.put("chronicle", e.getChronicle());
			m.put("output", e.isOutputEntry());
			out.add(m);
		}
		return out;
	}

	private ChronicleEntry entry(CharacterFacade c, String index)
	{
		List<ChronicleEntry> list = entryList(c);
		int i;
		try
		{
			i = Integer.parseInt(index);
		}
		catch (NumberFormatException e)
		{
			throw new ApiException(400, "chronicle index must be an integer");
		}
		if (i < 0 || i >= list.size())
		{
			throw new ApiException(404, "no chronicle entry at index " + i + " (there are " + list.size() + ")");
		}
		return list.get(i);
	}

	private void fill(ChronicleEntry e, Request q)
	{
		if (q.has("campaign"))
		{
			e.setCampaign(q.str("campaign"));
		}
		if (q.has("adventure"))
		{
			e.setAdventure(q.str("adventure"));
		}
		if (q.has("party"))
		{
			e.setParty(q.str("party"));
		}
		if (q.has("date"))
		{
			e.setDate(q.str("date"));
		}
		if (q.has("xp"))
		{
			e.setXpField(q.requireInt("xp"));
		}
		if (q.has("gm"))
		{
			e.setGmField(q.str("gm"));
		}
		if (q.has("chronicle"))
		{
			e.setChronicle(q.str("chronicle"));
		}
		if (q.has("output"))
		{
			e.setOutputEntry(q.bool("output", true));
		}
	}

	private Object chronicleChanged(CharacterFacade c, Map<String, Object> extra)
	{
		Map<String, Object> m = new LinkedHashMap<>(extra);
		m.put("chronicle", chronicle(c));
		m.put("messages", s.ui.drain());
		return m;
	}

	private Object addChronicle(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		int index = entryList(c).size();
		fill(c.getDescriptionFacade().createChronicleEntry(), q);
		return chronicleChanged(c, Map.of("created", index));
	}

	private Object patchChronicle(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		fill(entry(c, q.param("index")), q);
		return chronicleChanged(c, Map.of());
	}

	private Object deleteChronicle(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		c.getDescriptionFacade().removeChronicleEntry(entry(c, q.param("index")));
		return chronicleChanged(c, Map.of());
	}
}
