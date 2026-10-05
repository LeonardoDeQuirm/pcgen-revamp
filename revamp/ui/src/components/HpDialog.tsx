import { useState } from 'react'
import * as api from '../api'
import { useStore } from '../store'
import type { Changed, Character } from '../types'
import { Modal, signed } from './ui'

/**
 * Hit points for one level: type the number you rolled, or let the app roll, or take the maximum or average.
 * The engine adds Constitution (and any other bonus) to the die result, so what you enter is just the die.
 */
export function HpDialog({ character, level, onClose }: { character: Character; level: number; onClose: () => void }) {
  const { mutate } = useStore()
  const row = character.levels[level - 1]
  const die = row?.hitDie ?? 0
  const [text, setText] = useState(String(row?.hpRolled ?? ''))
  const [touched, setTouched] = useState(false)
  // Rolling changes the engine at once (unlike typing, which only counts on Save), so Cancel has to put the old roll back.
  const [rolledHere, setRolledHere] = useState(false)
  const [original] = useState(row?.hpRolled) // the roll as it was when the dialog opened (row changes once we roll)
  const id = encodeURIComponent(character.id)
  if (!row || !die) return null

  const bonus = row.hpBonus
  const value = Number(text)
  const valid = Number.isInteger(value) && value >= 1 && value <= die
  const average = Math.floor(die / 2) + 1 // the usual "average, rounded up" (d8 -> 5)

  const save = async () => {
    if (!valid) return
    if (value !== row.hpRolled) {
      const res = await mutate(() => api.put<Changed>(`/characters/${id}/levels/${level}/hp`, { rolled: value }))
      if (!res) return
    }
    onClose()
  }
  const roll = async () => {
    const res = await mutate(() => api.post<Changed & { rolled: number }>(`/characters/${id}/levels/${level}/hp/roll`, {}))
    if (res) {
      setText(String(res.rolled))
      setTouched(true)
      setRolledHere(true)
    }
  }
  const cancel = async () => {
    if (rolledHere && original != null) await mutate(() => api.put<Changed>(`/characters/${id}/levels/${level}/hp`, { rolled: original }))
    onClose()
  }

  return (
    <Modal
      title={`Hit points for level ${level}`}
      subtitle={`${row.class}${row.classLevel ? ` ${row.classLevel}` : ''} \u00b7 d${die}`}
      onClose={() => void cancel()}
      footer={
        <>
          <button className="btn ghost" onClick={() => void cancel()}>
            {touched ? 'Cancel' : 'Keep as is'}
          </button>
          <button className="btn primary" disabled={!valid} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <p className="muted" style={{ paddingBottom: 12, lineHeight: 1.5 }}>
        Roll your d{die} and type the result, or press Roll to have the app do it. The number shown to start with is the
        app&rsquo;s own roll.
        {level === 1 && ' Your first level normally takes the full die, so it starts at the maximum.'}
      </p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="field" style={{ width: 120 }}>
          <span>Rolled (1&ndash;{die})</span>
          <input
            className="input num"
            autoFocus
            inputMode="numeric"
            value={text}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => {
              setText(e.target.value)
              setTouched(true)
            }}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
          />
        </label>
        <button className="btn" style={{ marginTop: 18 }} onClick={() => void roll()}>
          Roll d{die}
        </button>
        <button
          className="btn ghost"
          style={{ marginTop: 18 }}
          onClick={() => {
            setText(String(die))
            setTouched(true)
          }}
        >
          Max ({die})
        </button>
        <button
          className="btn ghost"
          style={{ marginTop: 18 }}
          onClick={() => {
            setText(String(average))
            setTouched(true)
          }}
        >
          Average ({average})
        </button>
      </div>
      <div className="card" style={{ margin: '16px 0 18px', boxShadow: 'none', background: 'var(--surface-2)' }}>
        <div className="vital">
          <span className="vital-label">Your roll</span>
          <span className="vital-value num">{valid ? value : '\u2014'}</span>
        </div>
        <div className="vital">
          <span className="vital-label">Constitution and other bonuses</span>
          <span className="vital-value num">{signed(bonus)}</span>
        </div>
        <div className="vital">
          <span className="vital-label">Hit points gained</span>
          <span className="vital-value num">
            <b>{valid ? Math.max(1, value + bonus) : '\u2014'}</b>
          </span>
        </div>
      </div>
    </Modal>
  )
}
