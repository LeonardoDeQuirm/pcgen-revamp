import { useState } from 'react'
import * as api from '../api'
import { useStore } from '../store'
import type { Changed, Character } from '../types'
import { Picker } from './Picker'
import { useStartingGold } from './StartingGold'
import { Modal, signed } from './ui'

type Method = 'roll' | 'buy' | 'type'
type Step = 0 | 1 | 2 | 3

/** Pathfinder point-buy cost of a base score (7 to 18). */
const COST: Record<number, number> = { 7: -4, 8: -2, 9: -1, 10: 0, 11: 1, 12: 2, 13: 3, 14: 5, 15: 7, 16: 10, 17: 13, 18: 17 }
const POOLS = [
  { points: 10, label: 'Low fantasy (10 points)' },
  { points: 15, label: 'Standard (15 points)' },
  { points: 20, label: 'High fantasy (20 points)' },
  { points: 25, label: 'Epic fantasy (25 points)' },
]

/** Roll four six-sided dice and drop the lowest. */
function roll4d6(): number {
  const d = Array.from({ length: 4 }, () => 1 + Math.floor(Math.random() * 6))
  return d.reduce((a, b) => a + b, 0) - Math.min(...d)
}

const chosen = (v: string | null): string | null => (v && !v.startsWith('<') ? v : null)

const STEPS = ['Name and scores', 'Race', 'Class', 'Finish']

/**
 * Guided start for a new character. The character already exists (empty) when this opens; each step applies its
 * choice straight to it, so Cancel simply closes the unsaved character again.
 */
export function NewCharacterWizard({
  character,
  onDone,
  onCancel,
  goTo,
}: {
  character: Character
  onDone: () => void
  onCancel: () => void
  goTo: (tab: string) => void
}) {
  const { mutate, notify } = useStore()
  const id = encodeURIComponent(character.id)
  const keys = character.stats.map((s) => s.key)
  const [step, setStep] = useState<Step>(0)
  const [name, setName] = useState(character.name ?? '')
  const [method, setMethod] = useState<Method>('roll')
  const [scores, setScores] = useState<Record<string, number>>(() => Object.fromEntries(character.stats.map((s) => [s.key, s.base || 10])))
  const [pool, setPool] = useState<number[]>(() => Array.from({ length: keys.length }, roll4d6))
  const [assigned, setAssigned] = useState<Record<string, number | null>>({}) // ability key -> index into pool
  const [budget, setBudget] = useState(15)
  const [picker, setPicker] = useState<null | 'race' | 'class'>(null)
  const [busy, setBusy] = useState(false)
  const gold = useStartingGold(character)

  const usedPool = new Set(Object.values(assigned).filter((v): v is number => v !== null && v !== undefined))
  const score = (k: string): number | null => {
    if (method === 'roll') {
      const i = assigned[k]
      return i === null || i === undefined ? null : pool[i]
    }
    return scores[k]
  }
  const spent = keys.reduce((n, k) => n + (COST[scores[k]] ?? 0), 0)
  const scoresReady = method === 'roll' ? keys.every((k) => score(k) !== null) : method === 'buy' ? spent <= budget : true

  const applyScores = async (): Promise<boolean> => {
    for (const k of keys) {
      const v = score(k)
      if (v === null) continue
      const cur = character.stats.find((s) => s.key === k)?.base
      if (cur === v) continue
      const res = await mutate(() => api.put<Changed>(`/characters/${id}/stats/${k}`, { base: v }))
      if (!res) return false
    }
    return true
  }

  const next = async () => {
    setBusy(true)
    try {
      if (step === 0) {
        if (name.trim() && name !== character.name) {
          if (!(await mutate(() => api.patch<Changed>(`/characters/${id}`, { name: name.trim() })))) return
        }
        if (!(await applyScores())) return
      }
      setStep((s) => Math.min(3, s + 1) as Step)
    } finally {
      setBusy(false)
    }
  }

  const stepper = (
    <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
      {STEPS.map((t, i) => (
        <span key={t} className={'chip ' + (i === step ? 'warn' : '')} style={{ opacity: i <= step ? 1 : 0.55 }}>
          {i + 1}. {t}
        </span>
      ))}
    </div>
  )

  return (
    <Modal
      title="New character"
      subtitle="A few quick choices to get you started. Everything can be changed later."
      onClose={step === 3 ? onDone : onCancel}
      footer={
        <>
          {step < 3 && (
            <button className="btn ghost" onClick={onCancel}>
              Cancel
            </button>
          )}
          {step > 0 && step < 3 && (
            <button className="btn ghost" onClick={() => setStep((s) => (s - 1) as Step)}>
              Back
            </button>
          )}
          {step < 3 ? (
            <button className="btn primary" disabled={busy || (step === 0 && !scoresReady)} onClick={() => void next()}>
              {step === 2 && character.levels.length === 0 ? 'Skip' : 'Next'}
            </button>
          ) : (
            <button className="btn primary" onClick={onDone}>
              Finish
            </button>
          )}
        </>
      }
    >
      {stepper}

      {step === 0 && (
        <div style={{ display: 'grid', gap: 14 }}>
          <label className="field">
            <span>Character name</span>
            <input className="input" autoFocus value={name} onFocus={(e) => e.currentTarget.select()} onChange={(e) => setName(e.target.value)} />
          </label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {(
              [
                ['roll', 'Roll (4d6, drop lowest)'],
                ['buy', 'Point buy'],
                ['type', 'Type them in'],
              ] as [Method, string][]
            ).map(([m, label]) => (
              <button key={m} className={'btn small ' + (method === m ? 'primary' : '')} onClick={() => setMethod(m)}>
                {label}
              </button>
            ))}
          </div>

          {method === 'roll' && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="muted">Rolled:</span>
              {pool.map((v, i) => (
                <span key={i} className={'chip num ' + (usedPool.has(i) ? '' : 'warn')}>
                  {v}
                </span>
              ))}
              <button
                className="btn small"
                onClick={() => {
                  setPool(Array.from({ length: keys.length }, roll4d6))
                  setAssigned({})
                }}
              >
                Roll again
              </button>
            </div>
          )}
          {method === 'buy' && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <select className="input" style={{ width: 'auto' }} value={budget} onChange={(e) => setBudget(Number(e.target.value))}>
                {POOLS.map((p) => (
                  <option key={p.points} value={p.points}>
                    {p.label}
                  </option>
                ))}
              </select>
              <span className={'chip num ' + (spent > budget ? 'warn' : '')}>
                {spent} of {budget} points spent
              </span>
            </div>
          )}

          <div className="card" style={{ boxShadow: 'none', background: 'var(--surface-2)' }}>
            {character.stats.map((s) => {
              const v = score(s.key)
              return (
                <div key={s.key} className="vital">
                  <span className="vital-label">{s.name}</span>
                  <span className="vital-value num" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    {v !== null && <span className="muted">{signed(Math.floor((v - 10) / 2))}</span>}
                    {method === 'roll' && (
                      <select
                        className="input"
                        style={{ width: 90 }}
                        aria-label={`${s.name} score`}
                        value={assigned[s.key] ?? ''}
                        onChange={(e) => setAssigned((a) => ({ ...a, [s.key]: e.target.value === '' ? null : Number(e.target.value) }))}
                      >
                        <option value="">Pick…</option>
                        {pool.map((pv, i) =>
                          !usedPool.has(i) || assigned[s.key] === i ? (
                            <option key={i} value={i}>
                              {pv}
                            </option>
                          ) : null,
                        )}
                      </select>
                    )}
                    {method === 'buy' && (
                      <>
                        <button
                          className="btn small ghost"
                          aria-label={`Lower ${s.name}`}
                          disabled={scores[s.key] <= 7}
                          onClick={() => setScores((o) => ({ ...o, [s.key]: o[s.key] - 1 }))}
                        >
                          −
                        </button>
                        <b style={{ minWidth: 24, textAlign: 'center' }}>{scores[s.key]}</b>
                        <button
                          className="btn small ghost"
                          aria-label={`Raise ${s.name}`}
                          disabled={scores[s.key] >= 18 || spent - (COST[scores[s.key]] ?? 0) + (COST[scores[s.key] + 1] ?? 0) > budget}
                          onClick={() => setScores((o) => ({ ...o, [s.key]: o[s.key] + 1 }))}
                        >
                          +
                        </button>
                      </>
                    )}
                    {method === 'type' && (
                      <input
                        className="input num"
                        style={{ width: 70 }}
                        aria-label={`${s.name} score`}
                        inputMode="numeric"
                        value={scores[s.key]}
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => {
                          const n = Math.round(Number(e.target.value))
                          if (Number.isFinite(n) && n >= 1 && n <= 99) setScores((o) => ({ ...o, [s.key]: n }))
                        }}
                      />
                    )}
                  </span>
                </div>
              )
            })}
          </div>
          <p className="muted" style={{ lineHeight: 1.5 }}>
            These are the base scores, before race bonuses. The next step adds those.
          </p>
        </div>
      )}

      {step === 1 && (
        <div style={{ display: 'grid', gap: 12 }}>
          <p className="muted" style={{ lineHeight: 1.5 }}>
            Your race adds ability bonuses, size, speed and special abilities.
          </p>
          <div className="vital">
            <span className="vital-label">Race</span>
            <span className="vital-value">
              {chosen(character.race) || '—'}
              <button className="btn small" onClick={() => setPicker('race')}>
                {chosen(character.race) ? 'Change' : 'Choose a race'}
              </button>
            </span>
          </div>
          {!chosen(character.race) && <p className="muted">You can skip this and pick a race later on the Overview tab.</p>}
        </div>
      )}

      {step === 2 && (
        <div style={{ display: 'grid', gap: 12 }}>
          <p className="muted" style={{ lineHeight: 1.5 }}>
            Taking your first class level gives you hit points, skill points and class abilities. The game may then ask
            about your favored class and similar choices.
          </p>
          <div className="vital">
            <span className="vital-label">Class</span>
            <span className="vital-value">
              {character.levels[0]?.class ?? '—'}
              {character.levels.length === 0 && (
                <button className="btn small" onClick={() => setPicker('class')}>
                  Choose a class
                </button>
              )}
            </span>
          </div>
          {character.levels.length > 0 && (
            <p className="muted">
              Level 1 hit points: {character.levels[0].hpGained} (the first level takes the full die).
            </p>
          )}
        </div>
      )}

      {step === 3 && (
        <div style={{ display: 'grid', gap: 12 }}>
          <p style={{ lineHeight: 1.5 }}>
            <b>{character.name || 'Your character'}</b>
            {chosen(character.race) ? ` the ${chosen(character.race)}` : ''}
            {character.levels[0]?.class ? ` ${character.levels[0].class}` : ''} is ready.
          </p>
          {character.todo.length > 0 ? (
            <>
              <p className="muted">Still to do:</p>
              {character.todo.map((t, i) => (
                <div key={t.key + i} className="todo">
                  <span className="todo-dot" />
                  <span style={{ flex: 1 }}>
                    {t.message.includes('{0}') ? `${t.field ?? 'Selections'} remain to be chosen.` : t.message}
                  </span>
                  {t.tab && (
                    <button
                      className="btn small ghost"
                      onClick={() => {
                        goTo(t.tab ?? '')
                        onDone()
                      }}
                    >
                      {t.tab}
                    </button>
                  )}
                </div>
              ))}
            </>
          ) : (
            <p className="muted">Nothing outstanding.</p>
          )}
          {gold.available && (
            <div className="vital">
              <span className="vital-label">Starting gold</span>
              <span className="vital-value">
                {character.funds ?? 0} gp
                <button className="btn small" onClick={() => void gold.take()}>
                  Get starting gold
                </button>
              </span>
            </div>
          )}
          <p className="muted" style={{ lineHeight: 1.5 }}>
            Use <b>Save</b> when you are happy; the app will ask where to put the file.
          </p>
        </div>
      )}

      {picker === 'race' && (
        <Picker
          title="Choose a race"
          path="/dataset/races"
          previewKind="race"
          onClose={() => setPicker(null)}
          onPick={(it) => void mutate(() => api.patch<Changed>(`/characters/${id}`, { race: it.key ?? it.name }))}
        />
      )}
      {picker === 'class' && (
        <Picker
          title="Choose a class"
          subtitle="This adds your first level."
          path="/dataset/classes"
          previewKind="class"
          qualifyFilter
          describe={(it) => it.type?.replace('Base.', '').replace('.', ' · ')}
          onClose={() => setPicker(null)}
          onPick={(it) =>
            void mutate(() => api.post<Changed>(`/characters/${id}/levels`, { class: it.key ?? it.name })).then((r) => {
              if (r && r.character.levels.length === 0) notify('warn', 'The class was not added.')
            })
          }
        />
      )}
    </Modal>
  )
}
