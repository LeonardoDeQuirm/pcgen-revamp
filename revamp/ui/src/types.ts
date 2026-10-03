// Shapes returned by the sidecar. Kept in step with sidecar/.../CharacterView.java and the route classes.

export interface Stat {
  key: string
  name: string
  base: number
  raceBonus: number
  otherBonus: number
  total: string
  modifier: number
}

export interface LevelRow {
  level: number
  class: string | null
  /** Which level of that class this is (Inquisitor 3). */
  classLevel?: number
  /** Sides on the die this level is rolled on. */
  hitDie?: number
  /** What Constitution and other bonuses add to the roll. */
  hpBonus: number
  hpGained: number
  hpRolled: number
  skillPointsGained: number
  skillPointsSpent: number
  skillPointsRemaining: number
}

export interface ClassLevel {
  class: string
  level: number
}

export interface AbilityRow {
  key: string
  name: string
  nature: string | null
}

export interface AbilityCategory {
  key: string
  name: string
  total: number
  remaining: number
  abilities: AbilityRow[]
}

export interface Todo {
  message: string
  key: string
  tab: string | null
  field: string | null
}

export interface LanguageRow {
  name: string
  automatic: boolean
  removable: boolean
}

export interface Character {
  id: string
  name: string | null
  playersName: string | null
  tabName: string | null
  file: string | null
  dirty: boolean
  race: string | null
  alignment: string | null
  gender: string | null
  handed: string | null
  deity: string | null
  age: number
  ageCategory: string | null
  characterType: string | null
  xp: number
  xpForNextLevel: number
  xpTable: string | null
  hp: number
  funds: string | null
  wealth: string | null
  load: string | null
  carried: string | null
  weightLimit: string | null
  stats: Stat[]
  levels: LevelRow[]
  classes: ClassLevel[]
  abilityCategories: AbilityCategory[]
  templates: string[]
  languages: LanguageRow[]
  domains: { name: string }[]
  todo: Todo[]
}

export interface CharacterSummary {
  id: string
  name: string | null
  file: string | null
}

export interface Health {
  status: string
  gameMode: string
  sources: string[]
  characters: string[]
  pendingChooser: string | null
  pendingBuilder: string | null
  pendingConfirm: string | null
  pdfWarmup: string
  uptimeSeconds: number
}

export interface PendingConfirm {
  id: string
  title: string
  message: string
}

export interface ChooserOption {
  index: number
  name: string
  key: string
}

export interface PendingChooser {
  id: string
  title: string
  choicesRequired: number
  requireCompleteSelection: boolean
  preferSingleSelect: boolean
  freeTextInput: boolean
  alreadySelected: { index: number; name: string }[]
  options: ChooserOption[]
}

export interface ChooserAnswer {
  select?: number[]
  deselect?: number[]
  cancel?: boolean
}

export interface BuilderState {
  id: string
  baseItem: string
  name: string
  weapon: boolean
  damage: string | null
  resizable: boolean
  size: string | null
  heads: Record<string, { applied: string[]; availableCount: number }>
}

export interface EngineMessage {
  level: string
  title: string
  text: string
}

export interface CatalogItem {
  key?: string
  name: string
  source?: string
  type?: string
}

export interface Catalog {
  total: number
  items: CatalogItem[]
}

export interface FileEntry {
  name: string
  type: 'dir' | 'pcg'
  path: string
  size?: number
  modified?: number
}

export interface FileListing {
  dir: string
  parent: string | null
  home: string
  roots: string[]
  entries: FileEntry[]
}

export interface TemplateEntry {
  template: string
  kind: 'pdf' | 'text' | 'html' | 'xml'
}

export interface TemplateList {
  defaultPdf?: string | null
  defaultHtml?: string | null
  defaultText?: string | null
  total: number
  items: TemplateEntry[]
}

/** The standard reply to a change: the fresh character plus whatever the engine said. */
export interface Changed {
  character: Character
  messages: EngineMessage[]
  [extra: string]: unknown
}

/** What an ability does, as the engine describes it (see GET /characters/{id}/abilities/info). */
export interface AbilityInfo {
  key: string
  name: string
  category: string
  type: string | null
  source: string | null
  description: string | null
  /** What the character picked for a feat that asks (e.g. the weapon for Weapon Focus). */
  choices: string | null
  sections: { label: string; text: string }[]
}
