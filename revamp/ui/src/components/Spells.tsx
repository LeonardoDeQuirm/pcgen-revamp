import { useEffect, useMemo, useState } from 'react'
import * as api from '../api'
import { useStore } from '../store'
import type { Changed, Character } from '../types'
import { useDetail, type DetailRef } from '../detail'
import type { InfoLike } from './InfoBody'
import { PreviewPicker, type PickOption } from './PreviewPicker'
import { Card, Empty, useDebounced } from './ui'

interface SpellRow {
  class: string
  level: string
  spell: string
  list: string | null
  count: number
}

/** What the engine says a class can use right now (see GET /characters/{id}/spells, "classes"). */
interface ClassSlots {
  class: string
  classLevel: number
  casterType: string
  highestLevel: number
  levels: { level: number; perDay: number; known: number; knownNow: number; usable: boolean }[]
}

interface SpellView {
  classes?: ClassSlots[]
  known: SpellRow[]
  prepared: SpellRow[]
  book: SpellRow[]
  spellbooks: string[]
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
  return parts.join(' \u00b7 ')
}

export function Spells({ character }: { character: Character }) {
  const { act, mutate } = useStore()
  const detail = useDetail()
  const [view, setView] = useState<SpellView | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const id = encodeURIComponent(character.id)

  useEffect(() => {
    let live = true
    void act(() => api.get<SpellView>(`/characters/${id}/spells`)).then((v) => live && v && setView(v))
    return () => {
      live = false
    }
  }, [id, character, act])

  const grouped = useMemo(() => groupByClassLevel(view?.known ?? []), [view])
  if (!view) return <div className="empty"><span className="spinner" /></div>
  if (grouped.size === 0 && !adding)
    return <Empty title="No spells">This character has no spellcasting classes, or none have spells yet.</Empty>

  const remove = (r: SpellRow) =>
    mutate(() => api.del<Changed>(`/characters/${id}/spells/known`, { class: r.class, level: r.level, spell: r.spell }))

  return (
    <div className="grid" style={{ gap: 18 }}>
      {[...grouped.entries()].map(([cls, byLevel]) => (
        <Card
          key={cls}
          title={`${cls} spells`}
          action={
            <button className="btn small primary" onClick={() => setAdding(cls)}>
              Add spell
            </button>
          }
        >
          {[...byLevel.entries()]
            .sort((a, b) => Number(a[0]) - Number(b[0]))
            .map(([level, rows]) => (
              <div key={level} style={{ paddingBottom: 10 }}>
                <div className="muted" style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', padding: '4px 0' }}>
                  Level {level} <span className="num">&middot; {allowance(view.classes?.find((c) => c.class === cls), level, rows.length)}</span>
                  {uncastable(view.classes?.find((c) => c.class === cls), level) && (
                    <span className="chip bad" style={{ marginLeft: 8, textTransform: 'none', letterSpacing: 0 }}>can&rsquo;t cast yet</span>
                  )}
                </div>
                <div className="badge-row">
                  {rows.map((r) => {
                    const cant = uncastable(view.classes?.find((c) => c.class === cls), level)
                    const ref: DetailRef = { kind: 'spell', characterId: character.id, className: r.class, level: r.level, name: r.spell, removable: true, uncastable: cant }
                    return (
                      <span key={r.spell} className={'chip' + (cant ? ' bad' : detail.isOpen(ref) ? ' accent' : '')} title={cant ? `${r.class} can't cast level ${level} spells yet` : undefined}>
                        <button className="chip-link" onClick={() => detail.open(ref)} title="Show what this does">
                          {r.spell}
                        </button>
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
      ))}
      {view.prepared.length > 0 && (
        <Card title="Prepared">
          <div className="badge-row">
            {view.prepared.map((r, i) => (
              <span key={r.spell + i} className="chip accent">
                <button
                  className="chip-link"
                  onClick={() => detail.open({ kind: 'spell', characterId: character.id, className: r.class, level: r.level, name: r.spell, removable: false })}
                >
                  {r.spell}
                </button>{' '}
                <span className="num muted">{r.class} {r.level}</span>
              </span>
            ))}
          </div>
        </Card>
      )}
      {adding && <AddSpell character={character} className={adding} onClose={() => setAdding(null)} />}
    </div>
  )
}

function AddSpell({ character, className, onClose }: { character: Character; className: string; onClose: () => void }) {
  const { act, mutate } = useStore()
  const [rows, setRows] = useState<SpellRow[] | null>(null)
  const [slots, setSlots] = useState<ClassSlots | undefined>(undefined)
  const [q, setQ] = useState('')
  const [level, setLevel] = useState('all')
  const [higher, setHigher] = useState(false)
  const dq = useDebounced(q, 150)
  const id = encodeURIComponent(character.id)

  useEffect(() => {
    let live = true
    // No practical limit: a wizard's list across many books is well over a thousand spells.
    void act(() => api.get<SpellView>(`/characters/${id}/spells`, { available: true, class: className, limit: 100000 })).then((v) => {
      if (!live || !v) return
      setRows(v.available ?? [])
      setSlots(v.classes?.find((c) => c.class === className))
    })
    return () => {
      live = false
    }
  }, [id, className, act])

  // The engine lists every spell on the class list, up to its highest level (9 for a wizard). Offer the levels
  // the class can actually use right now; the rest are behind a switch so nothing is out of reach.
  const unique = [...new Map((rows ?? []).map((r) => [`${r.level}|${r.spell}`, r])).values()]
  const usable = new Set((slots?.levels ?? []).filter((l) => l.usable).map((l) => String(l.level)))
  // If the engine reports nothing usable (odd data), don't hide everything.
  const restrict = usable.size > 0
  // A class with a known-spells table (not a spellbook caster) can't take spells beyond its slots.
  const limited = !!slots && slots.levels.some((l) => l.known > 0)
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
          unavailable: tooHigh && limited,
          unavailableTag: 'no slot yet',
          tag: tooHigh && !limited ? "can't cast yet" : undefined,
          note: tooHigh
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
  const tip = (l: string) => {
    const lv = slots?.levels.find((x) => String(x.level) === l)
    return lv ? `Level ${l}: ${lv.knownNow}${lv.known > 0 ? ` of ${lv.known}` : ''} known${lv.perDay > 0 ? `, ${lv.perDay} per day` : ''}` : `Level ${l} spells`
  }

  return (
    <PreviewPicker
      title={`Add a ${className} spell`}
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
        void mutate(() => api.post<Changed>(`/characters/${id}/spells/known`, { class: className, level: lv, spell }))
      }}
      onClose={onClose}
    />
  )
}
