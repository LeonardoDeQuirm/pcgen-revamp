package pcgen.sidecar;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import pcgen.core.AbilityCategory;
import pcgen.core.PCClass;
import pcgen.core.PCStat;
import pcgen.core.PlayerCharacter;
import pcgen.facade.core.AbilityFacade;
import pcgen.facade.core.CharacterFacade;
import pcgen.facade.core.CharacterLevelFacade;
import pcgen.facade.core.CharacterLevelsFacade;
import pcgen.facade.core.TodoFacade;
import pcgen.facade.util.ReferenceFacade;
import pcgen.gui2.facade.SidecarAccess;
import pcgen.system.LanguageBundle;

/**
 * Turns live engine facades into plain maps for JSON. This is the one place that decides what
 * the client sees of a character; routes return {@link #snapshot} after a change so the client
 * can redraw from one consistent view.
 */
final class CharacterView
{
	private CharacterView()
	{
	}

	/** Display text for any engine object, or null. */
	static String text(Object o)
	{
		return o == null ? null : o.toString();
	}

	static <T> String text(ReferenceFacade<T> ref)
	{
		return ref == null ? null : text(ref.get());
	}

	static Map<String, Object> snapshot(String id, CharacterFacade c)
	{
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("id", id);
		m.put("name", text(c.getNameRef()));
		m.put("playersName", text(c.getPlayersNameRef()));
		m.put("tabName", text(c.getTabNameRef()));
		m.put("file", text(c.getFileRef()));
		m.put("dirty", c.isDirty());
		m.put("race", text(c.getRaceRef()));
		m.put("alignment", text(c.getAlignmentRef()));
		m.put("gender", text(c.getGenderRef()));
		m.put("handed", text(c.getHandedRef()));
		m.put("deity", text(c.getDeityRef()));
		m.put("age", c.getAgeRef().get());
		m.put("ageCategory", text(c.getAgeCategoryRef()));
		m.put("characterType", text(c.getCharacterTypeRef()));
		m.put("xp", c.getXPRef().get());
		m.put("xpForNextLevel", c.getXPForNextLevelRef().get());
		m.put("xpTable", text(c.getXPTableNameRef()));
		m.put("hp", c.getTotalHPRef().get());
		m.put("funds", text(c.getFundsRef()));
		m.put("wealth", text(c.getWealthRef()));
		m.put("load", text(c.getLoadRef()));
		m.put("carried", text(c.getCarriedWeightRef()));
		m.put("weightLimit", text(c.getWeightLimitRef()));
		m.put("stats", stats(c));
		m.put("levels", levels(c));
		m.put("classes", classes(c));
		m.put("abilityCategories", abilityCategories(c));
		m.put("templates", names(c.getTemplates()));
		m.put("languages", languages(c));
		m.put("domains", domains(c));
		m.put("todo", todo(c));
		return m;
	}

	static List<String> names(Iterable<?> items)
	{
		List<String> out = new ArrayList<>();
		for (Object o : items)
		{
			out.add(text(o));
		}
		return out;
	}

	static List<Map<String, Object>> stats(CharacterFacade c)
	{
		List<Map<String, Object>> out = new ArrayList<>();
		for (PCStat stat : c.getDataSet().getStats())
		{
			Map<String, Object> s = new LinkedHashMap<>();
			s.put("key", stat.getKeyName());
			s.put("name", stat.getDisplayName());
			s.put("base", c.getScoreBase(stat));
			s.put("raceBonus", c.getScoreRaceBonus(stat));
			s.put("otherBonus", c.getScoreOtherBonus(stat));
			s.put("total", c.getScoreTotalString(stat));
			s.put("modifier", c.getModTotal(stat));
			out.add(s);
		}
		return out;
	}

	static List<Map<String, Object>> levels(CharacterFacade c)
	{
		CharacterLevelsFacade lv = c.getCharacterLevelsFacade();
		PlayerCharacter pc = SidecarAccess.playerCharacter(c);
		Map<String, Integer> classLevels = new LinkedHashMap<>();
		List<Map<String, Object>> out = new ArrayList<>();
		int n = 0;
		for (CharacterLevelFacade level : lv)
		{
			Map<String, Object> l = new LinkedHashMap<>();
			PCClass cls = lv.getClassTaken(level);
			l.put("level", ++n);
			l.put("class", cls == null ? null : cls.getKeyName());
			if (cls != null)
			{
				int inClass = classLevels.merge(cls.getKeyName(), 1, Integer::sum);
				l.put("classLevel", inClass);
				// The die this level is rolled on (the engine applies race/template changes to it).
				l.put("hitDie", pc.getLevelHitDie(cls, inClass).getDie());
			}
			int rolled = lv.getHPRolled(level);
			int gained = lv.getHPGained(level);
			l.put("hpGained", gained);
			l.put("hpRolled", rolled);
			// What the character's Constitution and other bonuses add to the roll for this level.
			l.put("hpBonus", gained - rolled);
			l.put("skillPointsGained", lv.getGainedSkillPoints(level));
			l.put("skillPointsSpent", lv.getSpentSkillPoints(level));
			l.put("skillPointsRemaining", lv.getRemainingSkillPoints(level));
			out.add(l);
		}
		return out;
	}

	static List<Map<String, Object>> classes(CharacterFacade c)
	{
		CharacterLevelsFacade lv = c.getCharacterLevelsFacade();
		Map<String, Integer> counts = new LinkedHashMap<>();
		for (CharacterLevelFacade level : lv)
		{
			PCClass cls = lv.getClassTaken(level);
			if (cls != null)
			{
				counts.merge(cls.getKeyName(), 1, Integer::sum);
			}
		}
		List<Map<String, Object>> out = new ArrayList<>();
		counts.forEach((k, v) -> out.add(Map.of("class", k, "level", v)));
		return out;
	}

	static List<Map<String, Object>> abilityCategories(CharacterFacade c)
	{
		List<Map<String, Object>> out = new ArrayList<>();
		java.util.Set<String> gm = pcgen.gui2.facade.SidecarAccess.gmGranted(c);
		for (AbilityCategory cat : c.getActiveAbilityCategories())
		{
			Map<String, Object> m = new LinkedHashMap<>();
			m.put("key", cat.getKeyName());
			m.put("name", cat.getDisplayName());
			m.put("total", c.getTotalSelections(cat));
			m.put("remaining", c.getRemainingSelections(cat));
			List<Map<String, Object>> abilities = new ArrayList<>();
			for (AbilityFacade a : c.getAbilities(cat))
			{
				Map<String, Object> am = new LinkedHashMap<>();
				am.put("key", a.getKeyName());
				am.put("name", text(a));
				am.put("nature", text(c.getAbilityNature(a)));
				if (gm.contains(cat.getKeyName() + "|" + a.getKeyName()))
				{
					am.put("gm", true); // handed out by the GM: no prerequisites, no slot, marked on the sheet
				}
				abilities.add(am);
			}
			m.put("abilities", abilities);
			out.add(m);
		}
		return out;
	}

	static List<Map<String, Object>> languages(CharacterFacade c)
	{
		List<Map<String, Object>> out = new ArrayList<>();
		for (var lang : c.getLanguages())
		{
			Map<String, Object> m = new LinkedHashMap<>();
			m.put("name", text(lang));
			m.put("automatic", c.isAutomatic(lang));
			m.put("removable", c.isRemovable(lang));
			out.add(m);
		}
		return out;
	}

	static List<Map<String, Object>> domains(CharacterFacade c)
	{
		List<Map<String, Object>> out = new ArrayList<>();
		for (var q : c.getDomains())
		{
			out.add(Map.of("name", text(q.getRawObject())));
		}
		return out;
	}

	static List<Map<String, Object>> todo(CharacterFacade c)
	{
		List<Map<String, Object>> out = new ArrayList<>();
		for (TodoFacade t : c.getTodoList())
		{
			Map<String, Object> m = new LinkedHashMap<>();
			String key = t.getMessageKey();
			String message;
			try
			{
				message = LanguageBundle.getString(key);
			}
			catch (RuntimeException e)
			{
				message = key;
			}
			m.put("message", message);
			m.put("key", key);
			m.put("tab", text(t.getTab()));
			m.put("field", t.getFieldName());
			out.add(m);
		}
		return out;
	}
}
