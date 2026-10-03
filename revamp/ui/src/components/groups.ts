import type { AbilityCategory, Character } from '../types'

/** Where an ability category is shown: feats, class stuff, or race/background stuff. */
export type Group = 'feats' | 'class' | 'background'

const BACKGROUND = /racial|race|trait|drawback|ethnicity|region|origin|heritage|affliction|award|ability bonus/i
const FEAT = /\bfeats?\b/i

/**
 * PCGen files everything it grants under "ability categories" (feats, class features, racial traits, the
 * character's home region...). Sort them into the three places a player expects to find them. Anything we
 * don't recognise lands under Class, which is where most of the long tail (archetypes, mysteries,
 * judgments, favoured-class choices) belongs.
 */
export function groupOf(category: Pick<AbilityCategory, 'key' | 'name'>, character: Pick<Character, 'race'>): Group {
  if (category.key === 'FEAT' || FEAT.test(category.name)) return 'feats'
  if (/class|archetype|mystery|revelation|judgment|favou?red/i.test(category.name)) return 'class'
  if (character.race && category.name.startsWith(character.race)) return 'background'
  if (BACKGROUND.test(category.name)) return 'background'
  return 'class'
}

/** Visible categories of one group, in a sensible reading order. */
export function categoriesIn(character: Character, group: Group): AbilityCategory[] {
  const rank = (c: AbilityCategory) => (c.key === 'FEAT' ? 0 : /archetype/i.test(c.name) ? 1 : /favou?red/i.test(c.name) ? 3 : 2)
  return character.abilityCategories
    .filter((c) => (c.total > 0 || c.abilities.length > 0) && groupOf(c, character) === group)
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}
