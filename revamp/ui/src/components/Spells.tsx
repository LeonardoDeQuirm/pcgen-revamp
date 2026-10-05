import { useEffect, useMemo, useState } from 'react'
import * as api from '../api'
import { useStore } from '../store'
import type { Changed, Character } from '../types'
import { useDetail, type DetailRef } from '../detail'
import type { InfoLike } from './InfoBody'
import { DeityPicker } from './DeityPicker'
import { PreviewPicker, type PickOption } from './PreviewPicker'
import { Card, Empty, useDebounced } from './ui'

interface SpellRow {
  class: string
  level: string
  spell: string
  list: string | null
  count: number
  /** The level the spell has on its list (a metamagic spell is held at a higher level). */
  baseLevel?: number
  /** Metamagic feats applied to this prepared spell. */
  metamagic?: string[]
  /** The domain this spell comes from, when it is on the class's list only because of a domain. */
  domain?: string | null
}

interface MetamagicFeat {
  key: string
  name: string
  levelAdjust: number
}

/** What the engine says a class can use right now (see GET /characters/{id}/spells, "classes"). */
interface ClassSlots {
  class: string
  classLevel: number
  casterType: string
  highestLevel: number
  /** Prepared casters (wizard, cleric, druid...) choose their spells each day; the others know them and just cast. */
  prepares?: boolean
  levels: { level: number; perDay: number; known: number; knownNow: number; prepared?: number; preparedDomain?: number; bonus?: string; usable: boolean }[]
}

interface SpellView {
  classes?: ClassSlots[]
  known: SpellRow[]
  prepared: SpellRow[]
  book: SpellRow[]
  spellbooks: string[]
  defaultSpellbook?: string
  /** The character's own metamagic feats: the only ones that may be applied when preparing a spell. */
  metamagicFeats?: MetamagicFeat[]
  autoSpells: boolean
  available?: SpellRow[]
}

function groupByClassLevel(rows: SpellRow[]): Map<string, Map<string, SpellRow[]>> {
  const out = new Map<string, Map<string, SpellRow[]>>()
  for (const r of rows) {
    const byLevel = out.get(r.class) ?? new Map<string, SpellRow[]>()
    byLevel.set(r.level, [...(byLevel.get(r.level) ?? []), r])
    out.set(r.class, byLevel)
  }
  for (const byLevel of out.values()) for (const [k, v] of byLevel) byLevel.set(k, v.sort((a, b) => a.spell.localeCompare(b.spell)))
  return out
}

/** "9 known of 8 · 4 per day": what a class may have at one spell level. */
/** True when the class has no way to cast this spell level yet (but may still hold spells of it, e.g. in a spellbook). */
function uncastable(slots: ClassSlots | undefined, level: string): boolean {
  if (!slots || !slots.levels.some((l) => l.usable)) return false
  const lv = slots.levels.find((l) => String(l.level) === level)
  return !lv || !lv.usable
}

function allowance(slots: ClassSlots | undefined, level: string, have: number): string {
  const lv = slots?.levels.find((l) => String(l.level) === level)
  if (!lv) return `${have}`
  const parts = [lv.known > 0 ? `${have} of ${lv.known} known` : `${have} known`]
  if (lv.perDay > 0) parts.push(`${lv.perDay} per day`)
  else if (lv.level === 0 && lv.known > 0) parts.push('at will')
  return parts.join(' \u00b7 ')
}

export function Spells({ character }: { character: Character }) {
  const { act, mutate } = useStore()
  const detail = useDetail()
  const [view, setView] = useState<SpellView | null>(null)
  const [adding, setAdding] = useState<{ cls: string; mode: 'learn' | 'prepare' } | null>(null)
  const [listName, setListName] = useState<string | null>(null)
  const id = encodeURIComponent(character.id)

  useEffect(() => {
    let live = true
    void act(() => api.get<SpellView>(`/characters/${id}/spells`)).then((v) => live && v && setView(v))
    return () => {
      live = false
    }
  }, [id, character, act])

  const grouped = useMemo(() => groupByClassLevel((view?.known ?? []).filter((r) => !r.domain)), [view])
  // Spells a class has only because of a domain are kept apart: they are not "known" spells you chose.
  const domainRows = useMemo(() => (view?.known ?? []).filter((r) => r.domain), [view])
  if (!view) return <div className="empty"><span className="spinner" /></div>
  // Every class that can cast gets its card, even before it knows a single spell (a new wizard needs to add some).
  const casters = (view.classes ?? []).filter((c) => c.levels.some((l) => l.usable)).map((c) => c.class)
  const classNames = [...new Set([...casters, ...grouped.keys()])]
  if (classNames.length === 0 && !adding)
    return <Empty title="No spells">This character has no spellcasting classes.</Empty>

  const remove = (r: SpellRow) =>
    mutate(() => api.del<Changed>(`/characters/${id}/spells/known`, { class: r.class, level: r.level, spell: r.spell }))

  // Prepared spells live in a named list. People rarely want more than one, so use the character's own (or make
  // "Prepared" the first time one is needed) and only show a chooser when there are several.
  const lists = view.spellbooks
  const activeList = listName && lists.includes(listName) ? listName : view.defaultSpellbook && lists.includes(view.defaultSpellbook) ? view.defaultSpellbook : lists[0] ?? 'Prepared'
  const unprepare = (r: SpellRow) =>
    mutate(() => api.del<Changed>(`/characters/${id}/spells/prepared`, { class: r.class, level: r.level, spell: r.spell, list: r.list ?? activeList, metamagic: (r.metamagic ?? []).join(',') }))
  // A prepared copy is held at its slot level; the spell itself is found at its own level on the class's list.
  const prepareOne = async (r: SpellRow) => {
    if (!lists.includes(activeList)) {
      if (!(await mutate(() => api.post<Changed>(`/characters/${id}/spellbooks`, { name: activeList })))) return
    }
    await mutate(() =>
      api.post<Changed>(`/characters/${id}/spells/prepared`, { class: r.class, level: String(r.baseLevel ?? r.level), spell: r.spell, list: activeList, metamagic: r.metamagic ?? [] }),
    )
  }
  const newList = () => {
    const name = window.prompt('Name for the new list of prepared spells?', 'Prepared')?.trim()
    if (!name) return
    void mutate(() => api.post<Changed>(`/characters/${id}/spellbooks`, { name })).then((r) => r && setListName(name))
  }

  return (
    <div className="grid" style={{ gap: 18 }}>
      <Domains character={character} />
      {lists.length > 1 && (
        <div className="badge-row" role="group" aria-label="Prepared spell list">
          <span className="muted">Prepared list</span>
          {lists.map((l) => (
            <button key={l} className={'btn small ' + (l === activeList ? 'primary' : '')} aria-pressed={l === activeList} onClick={() => setListName(l)}>
              {l}
            </button>
          ))}
          <button className="btn small ghost" onClick={newList}>
            New list
          </button>
        </div>
      )}
      {classNames.map((cls) => {
        const byLevel = grouped.get(cls) ?? new Map<string, SpellRow[]>()
        const slots = view.classes?.find((c) => c.class === cls)
        const prepares = !!slots?.prepares
        const knownCount = (view.known ?? []).filter((r) => r.class === cls && !r.domain).length
        // The data also lists "Occultist Spell ~ Burning Hands"-style copies on domain lists; they are not real spells.
        const domainSpells = domainRows.filter((r) => r.class === cls && !r.spell.startsWith('Occultist Spell ~'))
        const domainsHere = [...new Set(domainSpells.map((r) => r.domain as string))]
        // A class that knows its whole list (cleric, druid...) has hundreds of "known" spells: don't list them all.
        const wholeList = prepares && !!slots && slots.levels.every((l) => l.known === 0) && knownCount > 60
        const preparedRows = view.prepared.filter((r) => r.class === cls && (r.list ?? activeList) === activeList)
        const preparedByLevel = groupByClassLevel(preparedRows).get(cls) ?? new Map<string, SpellRow[]>()
        return (
          <Card
            key={cls}
            title={`${cls} spells`}
            action={
              <span style={{ display: 'flex', gap: 8 }}>
                {prepares && (
                  <button className="btn small primary" onClick={() => setAdding({ cls, mode: 'prepare' })}>
                    Prepare spell
                  </button>
                )}
                {!wholeList && (
                  <button className={'btn small ' + (prepares ? '' : 'primary')} onClick={() => setAdding({ cls, mode: 'learn' })}>
                    {prepares ? 'Add to spellbook' : 'Add spell'}
                  </button>
                )}
              </span>
            }
          >
            {slots && <SlotSummary slots={slots} hasDomains={domainSpells.length > 0 || character.domains.length > 0} />}
            {prepares && (
              <div style={{ paddingBottom: 12 }}>
                <div className="muted" style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '4px 0' }}>
                  Prepared today{lists.length > 1 ? ` \u00b7 ${activeList}` : ''}
                </div>
                {preparedByLevel.size === 0 ? (
                  <div className="muted">Nothing prepared yet. Use Prepare spell to choose what to memorise.</div>
                ) : (
                  [...preparedByLevel.entries()]
                    .sort((a, b) => Number(a[0]) - Number(b[0]))
                    .map(([level, rows]) => (
                      <div key={level} className="badge-row" style={{ padding: '2px 0' }}>
                        <span className="chip num">Level {level}</span>
                        {rows.map((r) => {
                          const ref: DetailRef = { kind: 'spell', characterId: character.id, className: r.class, level: r.level, name: r.spell, removable: false }
                          return (
                            <span key={r.spell + (r.list ?? '') + (r.metamagic ?? []).join('+')} className={'chip accent' + (detail.isOpen(ref) ? ' on' : '')}>
                              <button className="chip-link" onClick={() => detail.open({ ...ref, level: String(r.baseLevel ?? r.level) })} title="Show what this does">
                                {r.spell}
                              </button>
                              {(r.metamagic?.length ?? 0) > 0 && <span className="muted"> ({r.metamagic?.join(', ')})</span>}
                              {r.domain && <span className="muted"> ({r.domain} domain)</span>}
                              {r.count > 1 && <span className="num"> &times;{r.count}</span>}
                              <button className="btn ghost small" style={{ padding: '0 2px' }} title="Prepare one more" aria-label={`Prepare another ${r.spell}`} onClick={() => void prepareOne(r)}>
                                +
                              </button>
                              <button className="btn ghost small" style={{ padding: '0 2px' }} title="Un-prepare one" aria-label={`Un-prepare ${r.spell}`} onClick={() => void unprepare(r)}>
                                &minus;
                              </button>
                            </span>
                          )
                        })}
                      </div>
                    ))
                )}
              </div>
            )}
            {wholeList && (
              <div className="muted" style={{ paddingBottom: 8 }}>
                {cls}s know every spell on their list ({knownCount} spells), so there is nothing to add: prepare the ones you want each day.
              </div>
            )}
            {!wholeList && prepares && byLevel.size > 0 && (
              <div className="muted" style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '4px 0' }}>
                In the spellbook
              </div>
            )}
            {!wholeList && byLevel.size === 0 && <div className="muted">No spells chosen yet. Use {prepares ? 'Add to spellbook' : 'Add spell'} to pick some.</div>}
            {domainSpells.length > 0 && (
              <div style={{ paddingBottom: 10 }}>
                <div className="muted" style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '4px 0' }}>
                  Domain spells &middot; {domainsHere.join(', ')}
                </div>
                {[...new Set(domainSpells.map((r) => r.level))]
                  .sort((a, b) => Number(a) - Number(b))
                  .map((level) => (
                    <div key={level} className="badge-row" style={{ padding: '2px 0' }}>
                      <span className="chip num">Level {level}</span>
                      {domainSpells
                        .filter((r) => r.level === level)
                        .map((r) => {
                          const ref: DetailRef = { kind: 'spell', characterId: character.id, className: r.class, level: r.level, name: r.spell, removable: false }
                          return (
                            <span key={r.spell + level} className={'chip' + (detail.isOpen(ref) ? ' accent' : '')}>
                              <button className="chip-link" onClick={() => detail.open(ref)} title="Show what this does">
                                {r.spell}
                              </button>
                              {prepares && (
                                <button className="btn ghost small" style={{ padding: '0 2px' }} title="Prepare this spell in the domain slot" aria-label={`Prepare ${r.spell}`} onClick={() => void prepareOne(r)}>
                                  +
                                </button>
                              )}
                            </span>
                          )
                        })}
                    </div>
                  ))}
              </div>
            )}
            {!wholeList &&
              [...byLevel.entries()]
                .sort((a, b) => Number(a[0]) - Number(b[0]))
                .map(([level, rows]) => (
                  <div key={level} style={{ paddingBottom: 10 }}>
                    <div className="muted" style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '4px 0' }}>
                      Level {level} <span className="num">&middot; {allowance(slots, level, rows.length)}</span>
                      {uncastable(slots, level) && (
                        <span className="chip bad" style={{ marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>can&rsquo;t cast yet</span>
                      )}
                    </div>
                    <div className="badge-row">
                      {rows.map((r) => {
                        const cant = uncastable(slots, level)
                        const ref: DetailRef = { kind: 'spell', characterId: character.id, className: r.class, level: r.level, name: r.spell, removable: true, uncastable: cant }
                        return (
                          <span key={r.spell} className={'chip' + (cant ? ' bad' : detail.isOpen(ref) ? ' accent' : '')} title={cant ? `${r.class} can't cast level ${level} spells yet` : undefined}>
                            <button className="chip-link" onClick={() => detail.open(ref)} title="Show what this does">
                              {r.spell}
                            </button>
                            {prepares && !cant && (
                              <button className="btn ghost small" style={{ padding: '0 2px' }} title="Prepare this spell" aria-label={`Prepare ${r.spell}`} onClick={() => void prepareOne(r)}>
                                +
                              </button>
                            )}
                            <button className="btn ghost small" style={{ padding: '0 2px' }} title="Remove" onClick={() => void remove(r)}>
                              &times;
                            </button>
                          </span>
                        )
                      })}
                    </div>
                  </div>
                ))}
          </Card>
        )
      })}
      {adding && (
        <AddSpell
          character={character}
          className={adding.cls}
          mode={adding.mode}
          listName={activeList}
          listExists={lists.includes(activeList)}
          onClose={() => setAdding(null)}
        />
      )}
    </div>
  )
}

interface DomainView {
  selected: { key: string; name: string; qualified: boolean }[]
  remaining: number
  available: { key: string; name: string; qualified: boolean; source?: string | null }[]
}

/** A cleric's (or similar) domains: the ones taken, how many are still to choose, and a picker with descriptions. */
function Domains({ character }: { character: Character }) {
  const { act, mutate } = useStore()
  const [view, setView] = useState<DomainView | null>(null)
  const [adding, setAdding] = useState(false)
  const [pickDeity, setPickDeity] = useState(false)
  const [q, setQ] = useState('')
  const id = encodeURIComponent(character.id)

  useEffect(() => {
    let live = true
    void act(() => api.get<DomainView>(`/characters/${id}/domains`)).then((v) => live && v && setView(v))
    return () => {
      live = false
    }
  }, [id, character, act])

  if (!view || (view.selected.length === 0 && view.remaining === 0)) return null
  const noDeity = !character.deity || /^(none|<)/i.test(character.deity)
  const have = new Set(view.selected.map((d) => d.key))
  const options: PickOption[] = view.available
    .filter((d) => !have.has(d.key) && d.name.toLowerCase().includes(q.toLowerCase()))
    .map((d) => ({ id: d.key, title: d.name, subtitle: d.source ?? undefined, unavailable: d.qualified === false, unavailableTag: 'requirements not met' }))
  return (
    <Card
      title={`Domains · ${view.selected.length}`}
      action={
        view.remaining > 0 ? (
          <button className="btn small primary" onClick={() => setAdding(true)}>
            Add domain
          </button>
        ) : undefined
      }
    >
      <div className="badge-row" style={{ paddingBottom: 8 }}>
        <span className="muted">Deity</span>
        <b>{noDeity ? 'none' : character.deity}</b>
        <button className="btn small ghost" onClick={() => setPickDeity(true)}>
          {noDeity ? 'Choose a deity' : 'Change'}
        </button>
      </div>
      {noDeity && view.available.length > 0 && view.available.every((d) => d.qualified === false) && (
        <p className="muted" style={{ paddingBottom: 8 }}>
          Domains depend on your deity: none can be taken until you choose one.
        </p>
      )}
      <div className="badge-row">
        {view.selected.map((d) => (
          <span key={d.key} className="chip accent">
            {d.name}
            <button
              className="btn ghost small"
              style={{ padding: '0 2px' }}
              title="Remove this domain"
              aria-label={`Remove ${d.name}`}
              onClick={() => void mutate(() => api.del<Changed>(`/characters/${id}/domains`, { name: d.key }))}
            >
              &times;
            </button>
          </span>
        ))}
        {view.selected.length === 0 && <span className="muted">None chosen yet.</span>}
      </div>
      {view.remaining > 0 && (
        <p className="muted" style={{ paddingTop: 8 }}>
          {view.remaining} more to choose. Each domain adds an extra spell slot every spell level and its own spells.
        </p>
      )}
      {pickDeity && <DeityPicker character={character} onClose={() => setPickDeity(false)} />}
      {adding && (
        <PreviewPicker
          title="Add a domain"
          options={options}
          query={q}
          onQuery={setQ}
          addLabel="Choose"
          loadInfo={(key) => act(() => api.get<InfoLike>(`/characters/${id}/domains/info`, { name: key }))}
          onAdd={(key) => void mutate(() => api.post<Changed>(`/characters/${id}/domains`, { name: key }))}
          onClose={() => setAdding(false)}
        />
      )}
    </Card>
  )
}

/** Orisons (level 0) of a class that knows some but gets no daily count can be cast at will. */
function perDayText(l: { level: number; perDay: number; known: number }): string {
  return l.level === 0 && l.perDay === 0 && l.known > 0 ? 'at will' : `${l.perDay}/day`
}

/** A line per usable spell level: how many per day, how many known, and for prepared casters how many are prepared. */
function SlotSummary({ slots, hasDomains }: { slots: ClassSlots; hasDomains: boolean }) {
  const levels = slots.levels.filter((l) => l.usable)
  if (levels.length === 0) return null
  return (
    <div className="badge-row" style={{ paddingBottom: 12 }} aria-label="Spells per day">
      {levels.map((l) => {
        if (slots.prepares) {
          const used = l.prepared ?? 0
          const extraSlots = Number((l.bonus ?? '').replace('+', '')) || 0
          // A cleric's domain slot holds a domain spell, which we can count. A specialist wizard's school slot holds
          // a spell of that school, which the engine does not mark, so it is only noted.
          const domainSlots = hasDomains ? extraSlots : 0
          const domainUsed = l.preparedDomain ?? 0
          const over = used > l.perDay || domainUsed > domainSlots
          const full = used === l.perDay && domainUsed === domainSlots
          const tone = l.perDay === 0 ? '' : over ? ' bad' : full ? ' good' : ' warn'
          const note = used > l.perDay ? `${used - l.perDay} too many` : used < l.perDay ? `${l.perDay - used} free` : 'full'
          return (
            <span
              key={l.level}
              className={'chip num' + tone}
              title={`Level ${l.level}: ${used} prepared of ${l.perDay} per day (${note})${l.bonus ? `, plus ${l.bonus.replace('+', '')} extra slot for ${hasDomains ? 'a domain spell' : 'a spell of your specialist school'} (not counted above)` : ''}`}
            >
              Level {l.level}: {used}/{l.perDay} prepared
              {domainSlots > 0 ? ` \u00b7 domain ${domainUsed}/${domainSlots}` : extraSlots > 0 ? ` \u00b7 ${l.bonus} school` : ''}
            </span>
          )
        }
        const over = l.known > 0 && l.knownNow > l.known
        return (
          <span key={l.level} className={'chip num' + (over ? ' bad' : '')} title={`Level ${l.level}: ${l.knownNow}${l.known > 0 ? ` of ${l.known}` : ''} known, ${l.perDay} per day`}>
            Level {l.level}: {l.knownNow}
            {l.known > 0 ? `/${l.known}` : ''} known &middot; {perDayText(l)}
          </span>
        )
      })}
    </div>
  )
}

function AddSpell({
  character,
  className,
  mode,
  listName,
  listExists,
  onClose,
}: {
  character: Character
  className: string
  mode: 'learn' | 'prepare'
  listName: string
  listExists: boolean
  onClose: () => void
}) {
  const preparing = mode === 'prepare'
  const { act, mutate } = useStore()
  const [rows, setRows] = useState<SpellRow[] | null>(null)
  const [slots, setSlots] = useState<ClassSlots | undefined>(undefined)
  const [q, setQ] = useState('')
  const [level, setLevel] = useState('all')
  const [higher, setHigher] = useState(false)
  const [feats, setFeats] = useState<MetamagicFeat[]>([])
  const [meta, setMeta] = useState<string[]>([])
  const [picked, setPicked] = useState<string | null>(null)
  const dq = useDebounced(q, 150)
  const id = encodeURIComponent(character.id)

  useEffect(() => {
    let live = true
    // No practical limit: a wizard's list across many books is well over a thousand spells.
    const query = preparing ? { class: className } : { available: true, class: className, limit: 100000 }
    void act(() => api.get<SpellView>(`/characters/${id}/spells`, query)).then((v) => {
      if (!live || !v) return
      setRows(preparing ? v.known : (v.available ?? []))
      setFeats(v.metamagicFeats ?? [])
      setSlots(v.classes?.find((c) => c.class === className))
    })
    return () => {
      live = false
    }
  }, [id, className, preparing, act])

  // The engine lists every spell on the class list, up to its highest level (9 for a wizard). Offer the levels
  // the class can actually use right now; the rest are behind a switch so nothing is out of reach.
  const unique = [...new Map((rows ?? []).map((r) => [`${r.level}|${r.spell}`, r])).values()]
  // To prepare a spell the class needs a slot for its level; to learn one it only needs the level to be usable.
  const usable = new Set((slots?.levels ?? []).filter((l) => (preparing ? l.perDay > 0 : l.usable)).map((l) => String(l.level)))
  // If the engine reports nothing usable (odd data), don't hide everything.
  const restrict = usable.size > 0
  // A class with a known-spells table (not a spellbook caster) can't take spells beyond its slots.
  const limited = !preparing && !!slots && slots.levels.some((l) => l.known > 0)
  const inScope = (r: SpellRow) => higher || !restrict || usable.has(r.level)
  const allLevels = [...new Set(unique.map((r) => r.level))].sort((a, b) => Number(a) - Number(b))
  const lockedLevels = restrict ? allLevels.filter((l) => !usable.has(l)) : []

  const byText = unique.filter((r) => inScope(r) && r.spell.toLowerCase().includes(dq.toLowerCase()))
  const levelCounts = new Map<string, number>()
  for (const r of byText) levelCounts.set(r.level, (levelCounts.get(r.level) ?? 0) + 1)
  // Only levels that have spells (for this search) get a button.
  const levels = allLevels.filter((l) => (levelCounts.get(l) ?? 0) > 0)
  const activeLevel = level !== 'all' && !levelCounts.get(level) ? 'all' : level
  const matches = byText
    .filter((r) => activeLevel === 'all' || r.level === activeLevel)
    .sort((a, b) => Number(a.level) - Number(b.level) || a.spell.localeCompare(b.spell))
  const LIMIT = 1500
  const options: PickOption[] | null = rows
    ? matches.slice(0, LIMIT).map((r) => {
        const tooHigh = restrict && !usable.has(r.level)
        return {
          id: `${r.level}|${r.spell}`,
          title: r.spell,
          subtitle: `Level ${r.level}`,
          // Classes with a fixed "spells known" table (inquisitor, sorcerer...) are refused by the engine above their
          // slots; spellbook classes (wizard) may hold spells they can't cast yet.
          unavailable: tooHigh && (limited || preparing),
          unavailableTag: 'no slot at this level',
          tag: tooHigh && !limited && !preparing ? "can't cast yet" : undefined,
          note: tooHigh && preparing
            ? `${className} has no spell slots of level ${r.level} yet, so this can't be prepared.`
            : tooHigh
            ? limited
              ? `${className} learns a fixed number of spells at each level and has none to learn at level ${r.level} yet. You can read about it; it unlocks as the class levels up.`
              : `${className} can't cast level ${r.level} spells yet. You can still add it to the spellbook; it will be marked in red on the Spells tab until the class can cast it.`
            : undefined,
        }
      })
    : null
  const split = (key: string) => {
    const i = key.indexOf('|')
    return { level: key.slice(0, i), spell: key.slice(i + 1) }
  }
  // The slot level a spell takes up: its own level plus what the chosen metamagic feats add.
  const slotLevel = (key: string) => Number(split(key).level) + meta.reduce((n, k) => n + (feats.find((f) => f.key === k)?.levelAdjust ?? 0), 0)
  const tip = (l: string) => {
    const lv = slots?.levels.find((x) => String(x.level) === l)
    return lv ? `Level ${l}: ${lv.knownNow}${lv.known > 0 ? ` of ${lv.known}` : ''} known${lv.perDay > 0 ? `, ${lv.perDay} per day` : ''}` : `Level ${l} spells`
  }

  return (
    <PreviewPicker
      title={preparing ? `Prepare a ${className} spell` : `Add a ${className} spell`}
      subtitle={slots ? `${className} level ${slots.classLevel}${restrict ? ` \u00b7 can use spell levels ${[...usable].sort((a, b) => Number(a) - Number(b)).join(', ')}` : ''}` : undefined}
      options={options}
      total={rows ? matches.length : undefined}
      query={q}
      onQuery={setQ}
      filters={
        rows && (
          <>
            <div className="level-filter" role="group" aria-label="Spell level">
              <button className={'lvl' + (activeLevel === 'all' ? ' on' : '')} aria-pressed={activeLevel === 'all'} onClick={() => setLevel('all')}>
                All <span className="num">{byText.length}</span>
              </button>
              {levels.map((l) => (
                <button key={l} className={'lvl' + (activeLevel === l ? ' on' : '')} aria-pressed={activeLevel === l} title={tip(l)} onClick={() => setLevel(l)}>
                  {l} <span className="num">{levelCounts.get(l) ?? 0}</span>
                </button>
              ))}
            </div>
            {lockedLevels.length > 0 && (
              <label className="check-row">
                <input type="checkbox" checked={higher} onChange={(e) => setHigher(e.target.checked)} />
                Also show higher levels ({lockedLevels.join(', ')}) this class can&rsquo;t cast yet{limited ? ' (read only)' : '. They can still be added.'}
              </label>
            )}
          </>
        )
      }
      loadInfo={(key) => {
        const { level: lv, spell } = split(key)
        return act(() => api.get<InfoLike>(`/characters/${id}/spells/info`, { class: className, level: lv, spell }))
      }}
      onAdd={(key) => {
        const { level: lv, spell } = split(key)
        if (!preparing) {
          void mutate(() => api.post<Changed>(`/characters/${id}/spells/known`, { class: className, level: lv, spell }))
          return
        }
        void (async () => {
          if (!listExists && !(await mutate(() => api.post<Changed>(`/characters/${id}/spellbooks`, { name: listName })))) return
          await mutate(() => api.post<Changed>(`/characters/${id}/spells/prepared`, { class: className, level: lv, spell, list: listName, metamagic: meta }))
        })()
      }}
      addLabel={preparing ? 'Prepare' : 'Add'}
      onSelect={(key) => {
        setPicked(key)
        setMeta([]) // metamagic is chosen per spell
      }}
      extra={
        preparing && feats.length > 0
          ? () => (
              <div className="card" style={{ margin: '12px 0', boxShadow: 'none', background: 'var(--surface-2)' }}>
                <div className="muted" style={{ fontWeight: 700, paddingBottom: 6 }}>
                  Metamagic (your feats)
                </div>
                {feats.map((f) => (
                  <label key={f.key} className="check-row">
                    <input
                      type="checkbox"
                      checked={meta.includes(f.key)}
                      onChange={(e) => setMeta((m) => (e.target.checked ? [...m, f.key] : m.filter((k) => k !== f.key)))}
                    />
                    {f.name} <span className="muted num">(+{f.levelAdjust} level{f.levelAdjust === 1 ? '' : 's'})</span>
                  </label>
                ))}
                {picked && meta.length > 0 && (
                  <div style={{ paddingTop: 6 }}>
                    Prepared as a level <b className="num">{slotLevel(picked)}</b> spell.
                  </div>
                )}
              </div>
            )
          : undefined
      }
      blocked={(key) => {
        if (!preparing || meta.length === 0) return null
        const lv = slotLevel(key)
        const top = Math.max(-1, ...(slots?.levels ?? []).filter((l) => l.perDay > 0).map((l) => l.level))
        return lv > top ? `With that metamagic this needs a level ${lv} slot, and ${className} has no slots above level ${top}.` : null
      }}
      onClose={onClose}
    />
  )
}
