package pcgen.sidecar;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import pcgen.cdom.enumeration.SkillCost;
import pcgen.core.Skill;
import pcgen.facade.core.CharacterFacade;
import pcgen.facade.core.CharacterLevelFacade;
import pcgen.facade.core.CharacterLevelsFacade;

/**
 * Skill ranks. The engine tracks ranks per character level (each level reports the running total),
 * and spending points is done at a particular level.
 */
final class SkillRoutes
{
	private final Session s;
	private final CharacterRoutes characters;

	SkillRoutes(Session s, CharacterRoutes characters)
	{
		this.s = s;
		this.characters = characters;
	}

	void register(Router r)
	{
		r.get("/characters/{id}/skills", this::list);
		r.post("/characters/{id}/skills", this::invest);
	}

	private List<CharacterLevelFacade> levelList(CharacterLevelsFacade lv)
	{
		List<CharacterLevelFacade> out = new ArrayList<>();
		lv.forEach(out::add);
		return out;
	}

	/** Lists skills. By default only skills with ranks; {@code all=true} lists every skill in the data set. */
	private Object list(Request q)
	{
		CharacterFacade c = s.character(q.param("id"));
		CharacterLevelsFacade lv = c.getCharacterLevelsFacade();
		List<CharacterLevelFacade> levels = levelList(lv);
		boolean all = q.bool("all", false);
		List<Map<String, Object>> out = new ArrayList<>();
		for (Skill skill : c.getDataSet().getSkills())
		{
			// getSkillRanks reports the running total up to and including that level, so the
			// character's ranks are the latest level's figure (summing levels would over-count).
			float ranks = levels.isEmpty() ? 0 : lv.getSkillRanks(levels.get(levels.size() - 1), skill);
			if (!all && ranks == 0)
			{
				continue;
			}
			Map<String, Object> m = new LinkedHashMap<>();
			m.put("key", skill.getKeyName());
			m.put("name", skill.getDisplayName());
			m.put("ranks", ranks);
			if (!levels.isEmpty())
			{
				CharacterLevelFacade last = levels.get(levels.size() - 1);
				SkillCost cost = lv.getSkillCost(last, skill);
				m.put("cost", cost == null ? null : cost.name());
				CharacterLevelsFacade.SkillBreakdown b = lv.getSkillBreakdown(last, skill);
				m.put("modifier", b == null ? null : b.modifier);
				m.put("total", b == null ? null : b.total);
			}
			out.add(m);
		}
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("skills", out);
		m.put("levels", CharacterView.levels(c));
		return m;
	}

	/** Spend ({@code points} &gt; 0) or refund ({@code points} &lt; 0) skill points at a level (default: the latest). */
	private Object invest(Request q)
	{
		String id = q.param("id");
		CharacterFacade c = s.character(id);
		CharacterLevelsFacade lv = c.getCharacterLevelsFacade();
		List<CharacterLevelFacade> levels = levelList(lv);
		if (levels.isEmpty())
		{
			throw new ApiException(409, "character has no levels yet");
		}
		int levelNumber = q.integer("level") == null ? levels.size() : q.requireInt("level");
		if (levelNumber < 1 || levelNumber > levels.size())
		{
			throw new ApiException(400, "level must be between 1 and " + levels.size());
		}
		Skill skill = Lookup.pObject(c.getDataSet().getSkills(), q.requireStr("skill"), "skill");
		int points = q.requireInt("points");
		boolean ok = lv.investSkillPoints(levels.get(levelNumber - 1), skill, points);
		return characters.changed(id, c, Map.of("applied", ok, "skill", skill.getKeyName()));
	}
}
