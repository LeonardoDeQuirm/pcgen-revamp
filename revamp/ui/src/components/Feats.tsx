import { useState } from 'react'
import * as api from '../api'
import { useStore } from '../store'
import type { AbilityCategory, Changed, Character } from '../types'
import { AbilityPicker } from './PreviewPicker'
import { useDetail, type DetailRef } from '../detail'
import { useCollapsed } from './collapse'
import { categoriesIn, GM_AWARDS, type Group } from './groups'
import { Card, Empty, Icon } from './ui'

/** A card whose header folds the body away. The action buttons stay visible so a collapsed section is still usable. */
function Section({ id, title, count, action, children }: { id: string; title: string; count?: number; action?: React.ReactNode; children: React.ReactNode }) {
  const { isCollapsed, toggle } = useCollapsed()
  const closed = isCollapsed(id)
  return (
    <section className="card collapsible" data-collapsed={closed} data-section={id}>
      <div className="card-title" style={{ marginBottom: closed ? 0 : 12 }}>
        <button className="card-toggle" aria-expanded={!closed} onClick={() => toggle(id)}>
          <span className="chev" data-open={!closed}>
            <Icon name="chevron" size={16} />
          </span>
          <span>{title}</span>
          {count !== undefined && <span className="count-pill num">{count}</span>}
        </button>
        {action}
      </div>
      {!closed && children}
    </section>
  )
}

export function Category({ character, category }: { character: Character; category: AbilityCategory }) {
  const { mutate } = useStore()
  const detail = useDetail()
  const [adding, setAdding] = useState(false)
  const id = encodeURIComponent(character.id)
  // GM awards have no slots to fill: a GM can hand out any of them, any number of times.
  const awards = category.key === GM_AWARDS
  return (
    <Section
      id={category.key}
      title={awards ? 'GM awards' : category.name}
      count={category.abilities.length}
      action={
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {category.gmBonusSlots !== undefined && (
            <span className="stepper" title="Extra feat slots the GM has handed out (the +1 Bonus Feat award)">
              <span className="muted" style={{ fontSize: 12 }}>
                GM bonus slots
              </span>
              <button
                className="btn small icon"
                aria-label="Take away a GM bonus feat slot"
                disabled={category.gmBonusSlots <= 0}
                onClick={() => void mutate(() => api.post<Changed>(`/characters/${id}/gm/bonus-feats`, { count: (category.gmBonusSlots ?? 0) - 1 }))}
              >
                <Icon name="minus" size={14} />
              </button>
              <b className="num">{category.gmBonusSlots}</b>
              <button
                className="btn small icon"
                aria-label="Give a GM bonus feat slot"
                onClick={() => void mutate(() => api.post<Changed>(`/characters/${id}/gm/bonus-feats`, { count: (category.gmBonusSlots ?? 0) + 1 }))}
              >
                <Icon name="plus" size={14} />
              </button>
            </span>
          )}
          {category.total > 0 && (
            <span className={'chip num ' + (category.remaining > 0 ? 'warn' : 'good')}>
              {category.remaining > 0 ? `${category.remaining} left to choose` : 'all chosen'}
            </span>
          )}
          {(category.total > 0 || awards) && (
            <button className="btn small primary" onClick={() => setAdding(true)}>
              Add
            </button>
          )}
        </span>
      }
    >
      {category.abilities.length === 0 ? (
        <div className="muted">{awards ? 'Nothing handed out by the GM yet. Add gives the list: bonus feats, languages, ability score changes and more.' : 'None yet.'}</div>
      ) : (
        <div className="rows">
          {category.abilities.map((a) => {
            // The feat and language awards are lists of what was given; those are taken back where they show (the feat
            // list, the languages card), so the feat or language goes with them.
            const listAward = awards && (a.key === 'Add a Feat Ignoring Restrictions' || a.key === 'Add Language')
            const removable = awards ? !listAward : category.total > 0 && (!!a.gm || !a.nature || a.nature === 'NORMAL')
            const used = awards ? (a.choices && a.choices.length > 0 ? a.choices.join(', ') : (a.times ?? 0) > 1 ? `Given ${a.times} times` : '') : ''
            const ref: DetailRef = { kind: 'ability', characterId: character.id, categoryKey: category.key, categoryName: category.name, key: a.key, name: a.name, removable }
            const selected = detail.isOpen(ref)
            return (
              <div
                key={a.key + a.name}
                className={'row clickable' + (selected ? ' selected' : '')}
                role="button"
                tabIndex={0}
                aria-pressed={selected}
                title="Show what this does"
                onClick={() => detail.open(ref)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), detail.open(ref))}
              >
                <div className="row-main">
                  <div className="row-title">{a.name}</div>
                  {used && <div className="row-sub">{used}</div>}
                </div>
                <span style={{ display: 'flex', gap: 8, alignItems: 'center' }} onClick={(e) => e.stopPropagation()}>
                  {listAward && (
                    <span className="muted" style={{ fontSize: 12 }}>
                      {a.key === 'Add Language' ? 'change under Biography › Languages' : 'change in the feat list above'}
                    </span>
                  )}
                  {a.gm && <span className="chip accent" title="Handed out by the GM (PCGen's GM award): ignores prerequisites">GM</span>}
                  {!a.gm && category.total > 0 && a.nature && a.nature !== 'NORMAL' && <span className="chip">granted</span>}
                  {removable && (
                    <button
                      className="btn small ghost danger"
                      onClick={() => void mutate(() => api.del<Changed>(`/characters/${id}/abilities`, { category: category.key, name: a.key }))}
                    >
                      Remove
                    </button>
                  )}
                </span>
                <span className="row-chevron" aria-hidden="true">
                  <Icon name="chevron" size={14} />
                </span>
              </div>
            )
          })}
        </div>
      )}
      {adding && <AbilityPicker character={character} categoryKey={category.key} categoryName={category.name} onClose={() => setAdding(false)} />}
    </Section>
  )
}

function GroupPage({ character, group, emptyTitle, emptyText }: { character: Character; group: Group; emptyTitle: string; emptyText: string }) {
  const shown = categoriesIn(character, group)
  const { setMany, isCollapsed } = useCollapsed()
  if (shown.length === 0) return <Empty title={emptyTitle}>{emptyText}</Empty>
  const keys = shown.map((c) => c.key)
  const allClosed = keys.every((k) => isCollapsed(k))
  return (
    <div className="grid" style={{ gap: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="muted">Select an entry to read what it does.</span>
        <button className="btn small" onClick={() => setMany(keys, !allClosed)}>
          {allClosed ? 'Expand all' : 'Collapse all'}
        </button>
      </div>
      {shown.map((c) => (
        <Category key={c.key} character={character} category={c} />
      ))}
    </div>
  )
}

export function Feats({ character }: { character: Character }) {
  return <GroupPage character={character} group="feats" emptyTitle="No feats yet" emptyText="Level up to unlock feat choices." />
}

/** Class features, archetypes, favoured-class choices and the like. */
export function ClassTab({ character }: { character: Character }) {
  return <GroupPage character={character} group="class" emptyTitle="No class abilities yet" emptyText="Take a class level to see its features here." />
}

/** One category as a label plus chips, for the compact background card. */
function CompactCategory({ character, category }: { character: Character; category: AbilityCategory }) {
  const { mutate } = useStore()
  const detail = useDetail()
  const [adding, setAdding] = useState(false)
  const id = encodeURIComponent(character.id)
  const choosable = category.total > 0
  return (
    <div>
      <div className="muted" style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', paddingBottom: 6 }}>
        {category.name}
        {choosable && category.remaining > 0 && <span className="chip warn num" style={{ marginLeft: 8 }}>{category.remaining} to choose</span>}
      </div>
      <div className="badge-row">
        {category.abilities.map((a) => {
          const removable = choosable && (!a.nature || a.nature === 'NORMAL')
          const ref: DetailRef = { kind: 'ability', characterId: character.id, categoryKey: category.key, categoryName: category.name, key: a.key, name: a.name, removable }
          return (
            <span key={a.key + a.name} className={'chip' + (detail.isOpen(ref) ? ' accent' : '')}>
              <button className="chip-link" onClick={() => detail.open(ref)} title="Show what this does">
                {a.name}
              </button>
              {removable && (
                <button
                  className="btn ghost small"
                  style={{ padding: '0 2px' }}
                  title={`Remove ${a.name}`}
                  onClick={() => void mutate(() => api.del<Changed>(`/characters/${id}/abilities`, { category: category.key, name: a.key }))}
                >
                  &times;
                </button>
              )}
            </span>
          )
        })}
        {choosable && (
          <button className="chip accent" style={{ cursor: 'pointer', border: 0 }} onClick={() => setAdding(true)}>
            + Add
          </button>
        )}
        {category.abilities.length === 0 && !choosable && <span className="muted">None</span>}
      </div>
      {adding && <AbilityPicker character={character} categoryKey={category.key} categoryName={category.name} onClose={() => setAdding(false)} />}
    </div>
  )
}

/** Racial traits, character traits, ethnicity, region of origin and similar background choices, in one card. */
export function Background({ character }: { character: Character }) {
  const shown = categoriesIn(character, 'background')
  if (shown.length === 0) return null
  return (
    <Card title="Race & background">
      <div className="grid cols-2" style={{ gap: '18px 28px' }}>
        {shown.map((c) => (
          <CompactCategory key={c.key} character={character} category={c} />
        ))}
      </div>
    </Card>
  )
}
