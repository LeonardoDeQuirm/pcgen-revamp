package pcgen.sidecar;

import java.io.File;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeSet;

import pcgen.core.Domain;
import pcgen.core.PCClass;
import pcgen.core.PCStat;
import pcgen.core.QualifiedObject;
import pcgen.facade.core.CharacterFacade;
import pcgen.facade.core.CharacterLevelFacade;
import pcgen.facade.core.SourceSelectionFacade;
import pcgen.system.CharacterManager;

/** Character lifecycle (open, new, save, close, export) and the core character sheet fields. */
final class CharacterRoutes
{
	private final Session s;

	CharacterRoutes(Session s)
	{
		this.s = s;
	}

	void register(Router r)
	{
		r.get("/characters", q -> summaries());
		r.post("/characters", this::open);
		r.post("/characters/new", this::create);
		r.get("/characters/{id}", q -> CharacterView.snapshot(q.param("id"), s.character(q.param("id"))));
		r.patch("/characters/{id}", this::patch);
		r.delete("/characters/{id}", this::close);
		r.post("/characters/{id}/save", this::save);

		r.put("/characters/{id}/stats/{stat}", this::setStat);
		r.post("/characters/{id}/stats/roll", this::rollStats);

		r.post("/characters/{id}/levels", this::addLevels);
		r.delete("/characters/{id}/levels", this::removeLevels);
		r.put("/characters/{id}/levels/{level}/hp", this::setHitPoints);
		r.post("/characters/{id}/levels/{level}/hp/roll", this::rollHitPoints);

		r.post("/characters/{id}/templates", this::addTemplate);
		r.delete("/characters/{id}/templates", this::removeTemplate);
		r.post("/characters/{id}/domains", this::addDomain);
		r.delete("/characters/{id}/domains", this::removeDomain);
	}

	// ---- helpers ----

	/** Standard reply for a change: the fresh character view plus any engine messages. */
	Map<String, Object> changed(String id, CharacterFacade c, Map<String, Object> extra)
	{
		Map<String, Object> m = new LinkedHashMap<>();
		m.putAll(extra);
		m.put("character", CharacterView.snapshot(id, c));
		m.put("messages", s.ui.drain());
		return m;
	}

	private Object changed(Request q)
	{
		return changed(q.param("id"), s.character(q.param("id")), Map.of());
	}

	private List<Object> summaries()
	{
		List<Object> out = new ArrayList<>();
		s.all().forEach((id, c) -> out.add(summary(id, c)));
		return out;
	}

	private Map<String, Object> summary(String id, CharacterFacade c)
	{
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("id", id);
		m.put("name", CharacterView.text(c.getNameRef()));
		m.put("file", CharacterView.text(c.getFileRef()));
		return m;
	}

	// ---- lifecycle ----

	private Object open(Request q)
	{
		File file = new File(q.requireStr("path")).getAbsoluteFile();
		if (!file.isFile())
		{
			throw new ApiException(404, "no such file: " + file);
		}
		String id = file.getName().replaceFirst("\\.[^.]*$", "");
		if (s.isOpen(id))
		{
			throw new ApiException(409, "a character with id '" + id + "' is already open");
		}
		SourceSelectionFacade needed = CharacterManager.getRequiredSourcesForCharacter(file, s.ui);
		if (needed == null)
		{
			throw new ApiException(422, "cannot read character sources: " + s.ui.drain());
		}
		List<String> needNames = new ArrayList<>();
		needed.getCampaigns().forEach(c -> needNames.add(c.getKeyName()));
		// Every book the character needs must be loaded. Extra books (see --extra-sources) are fine: the character
		// just has more to choose from.
		if (!needed.getGameMode().get().getName().equals(s.gameMode.getName())
				|| !new TreeSet<>(s.campaignNames()).containsAll(needNames))
		{
			throw new ApiException(409, "character needs " + needed.getGameMode().get().getName() + " " + needNames
					+ " but this sidecar loaded " + s.gameMode.getName() + " " + s.campaignNames());
		}
		CharacterFacade c = CharacterManager.openCharacter(file, s.ui, s.dataSet());
		if (c == null)
		{
			throw new ApiException(422, "engine failed to open character: " + s.ui.drain());
		}
		s.put(id, c);
		// Load-time warnings (e.g. spells or feats the data set doesn't have) arrive as messages.
		Map<String, Object> m = summary(id, c);
		m.put("messages", s.ui.drain());
		return m;
	}

	private Object create(Request q)
	{
		CharacterFacade c = CharacterManager.createNewCharacter(s.ui, s.dataSet());
		if (c == null)
		{
			throw new ApiException(500, "engine failed to create a character: " + s.ui.drain());
		}
		String id = s.freshId(q.has("id") ? q.str("id") : "new");
		s.put(id, c);
		if (q.has("name"))
		{
			c.setName(q.str("name"));
		}
		return changed(id, c, Map.of());
	}

	private Object close(Request q)
	{
		String id = q.param("id");
		CharacterManager.removeCharacter(s.character(id));
		s.remove(id);
		return Map.of("closed", id);
	}

	private Object save(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		File previous = c.getFileRef().get();
		File target = previous;
		if (q.has("path"))
		{
			String path = q.requireStr("path");
			if (!path.toLowerCase(Locale.ROOT).endsWith(".pcg"))
			{
				throw new ApiException(400, "character files end in .pcg");
			}
			target = new File(path).getAbsoluteFile();
			File folder = target.getParentFile();
			if (folder == null || !folder.isDirectory())
			{
				throw new ApiException(400, "that folder does not exist: " + folder);
			}
		}
		if (target == null)
		{
			throw new ApiException(400, "character has no file yet; pass path");
		}
		boolean changedFile = !target.equals(previous);
		if (changedFile)
		{
			c.setFile(target);
		}
		boolean ok = false;
		try
		{
			ok = CharacterManager.saveCharacter(c);
		}
		finally
		{
			// A failed save must not leave the character pointing at a file that was never written.
			if (!ok && changedFile)
			{
				c.setFile(previous);
			}
		}
		if (!ok)
		{
			throw new ApiException(500, "save failed: " + s.ui.drain());
		}
		return changed(id, c, Map.of("saved", true));
	}

	// ---- identity fields ----

	private Object patch(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		var data = s.dataSet();

		// 1. Look everything up and parse every number first. A bad value anywhere refuses the whole request
		//    before the first change is made, so a rejected request never leaves half of itself applied.
		var race = q.has("race") ? Lookup.pObject(data.getRaces(), q.requireStr("race"), "race") : null;
		var alignment = q.has("alignment") ? Lookup.pObject(data.getAlignments(), q.requireStr("alignment"), "alignment") : null;
		var deity = q.has("deity") ? Lookup.pObject(data.getDeities(), q.requireStr("deity"), "deity") : null;
		var gender = q.has("gender")
				? Lookup.find(c.getAvailableGenders(), q.requireStr("gender"), "gender", Enum::name, Object::toString) : null;
		var handed = q.has("handed")
				? Lookup.find(c.getAvailableHands(), q.requireStr("handed"), "handedness", Enum::name, Object::toString) : null;
		Integer age = q.has("age") ? q.requireInt("age") : null;
		String ageCategory = q.has("ageCategory") ? q.requireStr("ageCategory") : null;
		String xpTable = q.has("xpTable") ? q.requireStr("xpTable") : null;
		String characterType = q.has("characterType") ? q.requireStr("characterType") : null;
		Integer xp = q.has("xp") ? q.requireInt("xp") : null;
		Integer addXp = q.has("addXp") ? q.requireInt("addXp") : null;
		BigDecimal funds = null;
		if (q.has("funds"))
		{
			try
			{
				funds = new BigDecimal(q.requireStr("funds"));
			}
			catch (NumberFormatException e)
			{
				throw new ApiException(400, "funds must be a number");
			}
		}

		// 2. Apply. Order matters a little: race and class-affecting choices before cosmetic fields.
		if (race != null)
		{
			c.setRace(race);
		}
		if (alignment != null)
		{
			c.setAlignment(alignment);
		}
		if (deity != null)
		{
			c.setDeity(deity);
		}
		if (gender != null)
		{
			c.setGender(gender);
		}
		if (handed != null)
		{
			c.setHanded(handed);
		}
		if (q.has("name"))
		{
			c.setName(q.str("name"));
		}
		if (q.has("playersName"))
		{
			c.setPlayersName(q.str("playersName"));
		}
		if (q.has("tabName"))
		{
			c.setTabName(q.str("tabName"));
		}
		if (age != null)
		{
			c.setAge(age);
		}
		if (ageCategory != null)
		{
			c.setAgeCategory(ageCategory);
		}
		if (xpTable != null)
		{
			c.setXPTable(xpTable);
		}
		if (characterType != null)
		{
			c.setCharacterType(characterType);
		}
		if (xp != null)
		{
			c.setXP(xp);
		}
		if (addXp != null)
		{
			c.adjustXP(addXp);
		}
		if (funds != null)
		{
			c.setFunds(funds);
		}
		return changed(q);
	}

	// ---- stats ----

	private PCStat stat(String key)
	{
		return Lookup.pObject(s.dataSet().getStats(), key, "stat");
	}

	private Object setStat(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		c.setScoreBase(stat(q.param("stat")), q.requireInt("base"));
		return changed(q);
	}

	private Object rollStats(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		if (!c.isStatRollEnabled())
		{
			throw new ApiException(409, "stat rolling is not enabled for this character's roll method");
		}
		c.rollStats();
		return changed(q);
	}

	// ---- levels ----

	private PCClass pcClass(String name)
	{
		return Lookup.pObject(s.dataSet().getClasses(), name, "class");
	}

	private Object addLevels(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		int count = q.integer("count") == null ? 1 : q.requireInt("count");
		if (count < 1 || count > 20)
		{
			throw new ApiException(400, "count must be 1-20");
		}
		PCClass cls = pcClass(q.requireStr("class"));
		if (!c.isQualifiedFor(cls))
		{
			throw new ApiException(409, "character does not qualify for class " + cls.getKeyName());
		}
		PCClass[] classes = new PCClass[count];
		java.util.Arrays.fill(classes, cls);
		c.addCharacterLevels(classes);
		return changed(q);
	}

	private Object removeLevels(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		int count = q.integer("count") == null ? 1 : q.requireInt("count");
		if (count < 1 || count > c.getCharacterLevelsFacade().getSize())
		{
			throw new ApiException(400, "count must be between 1 and the character's level ("
					+ c.getCharacterLevelsFacade().getSize() + ")");
		}
		c.removeCharacterLevels(count);
		return changed(q);
	}

	private CharacterLevelFacade levelAt(CharacterFacade c, String number)
	{
		int n;
		try
		{
			n = Integer.parseInt(number);
		}
		catch (NumberFormatException e)
		{
			throw new ApiException(400, "level must be a number");
		}
		List<CharacterLevelFacade> levels = new ArrayList<>();
		c.getCharacterLevelsFacade().forEach(levels::add);
		if (n < 1 || n > levels.size())
		{
			throw new ApiException(404, "this character has levels 1 to " + levels.size() + ", not " + n);
		}
		return levels.get(n - 1);
	}

	/** The die this level is rolled on, as CharacterView reports it. */
	private int hitDieOf(CharacterFacade c, String number)
	{
		Object die = CharacterView.levels(c).get(Integer.parseInt(number) - 1).get("hitDie");
		if (!(die instanceof Integer d) || d < 1)
		{
			throw new ApiException(409, "level " + number + " has no hit die");
		}
		return d;
	}

	/** Sets the number rolled on the die for one level (the bonus from Constitution is added by the engine). */
	private Object setHitPoints(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		CharacterLevelFacade level = levelAt(c, q.param("level"));
		int die = hitDieOf(c, q.param("level"));
		int rolled = q.requireInt("rolled");
		if (rolled < 1 || rolled > die)
		{
			throw new ApiException(400, "a d" + die + " can only roll 1 to " + die);
		}
		c.getCharacterLevelsFacade().setHPRolled(level, rolled);
		return changed(q);
	}

	/** Rolls the level's die for the player and records the result. */
	private Object rollHitPoints(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		CharacterLevelFacade level = levelAt(c, q.param("level"));
		int die = hitDieOf(c, q.param("level"));
		int rolled = 1 + new java.util.Random().nextInt(die);
		c.getCharacterLevelsFacade().setHPRolled(level, rolled);
		Map<String, Object> extra = new LinkedHashMap<>();
		extra.put("rolled", rolled);
		extra.put("die", die);
		return changed(q.param("id"), c, extra);
	}

	// ---- templates, domains, languages ----

	private Object addTemplate(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		var t = Lookup.pObject(s.dataSet().getTemplates(), q.requireStr("name"), "template");
		if (!c.isQualifiedFor(t))
		{
			throw new ApiException(409, "character does not qualify for template " + t.getKeyName());
		}
		c.addTemplate(t);
		return changed(q);
	}

	private Object removeTemplate(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		c.removeTemplate(Lookup.pObject(c.getTemplates(), q.requireStr("name"), "template on this character"));
		return changed(q);
	}

	private QualifiedObject<Domain> domain(Iterable<QualifiedObject<Domain>> items, String name)
	{
		return Lookup.find(items, name, "domain", d -> d.getRawObject().getKeyName(), d -> d.getRawObject().getDisplayName());
	}

	private Object addDomain(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		c.addDomain(domain(c.getAvailableDomains(), q.requireStr("name")));
		return changed(q);
	}

	private Object removeDomain(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		c.removeDomain(domain(c.getDomains(), q.requireStr("name")));
		return changed(q);
	}
}
