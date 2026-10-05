import { useEffect, useMemo, useState } from 'react'
import * as api from '../api'
import { useStore } from '../store'
import type { Changed, Character } from '../types'
import { catalogRef, useDetail } from '../detail'
import { Card, Empty, Icon, signed } from './ui'

interface SkillRow {
  key: string
  name: string
  ranks: number
  cost?: string | null
  modifier?: number | null
  total?: number | null
}

export function Skills({ character }: { character: Character }) {
  const { act, mutate } = useStore()
  const detail = useDetail()
  const [rows, setRows] = useState<SkillRow[]>([])
  const [all, setAll] = useState(false)
  const [q, setQ] = useState('')
  const id = encodeURIComponent(character.id)
  const remaining = character.levels.reduce((n, l) => n + l.skillPointsRemaining, 0)

  // The character object changes after every edit, so this also refreshes after spending points.
  useEffect(() => {
    let live = true
    void act(() => api.get<{ skills: SkillRow[] }>(`/characters/${id}/skills`, { all })).then((r) => live && r && setRows(r.skills))
    return () => {
      live = false
    }
  }, [id, all, character, act])

  const shown = useMemo(() => rows.filter((r) => r.name.toLowerCase().includes(q.toLowerCase())), [rows, q])

  const spend = (skill: SkillRow, points: number) =>
    mutate(() => api.post<Changed>(`/characters/${id}/skills`, { skill: skill.key, points }))

  if (character.levels.length === 0) return <Empty title="No skills yet">Take a level first; skill points come with levels.</Empty>

  return (
    <Card
      title="Skills"
      action={
        <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className={'chip num ' + (remaining > 0 ? 'warn' : 'good')}>{remaining > 0 ? `${remaining} points to spend` : 'all points spent'}</span>
        </span>
      }
    >
      <div style={{ display: 'flex', gap: 12, paddingBottom: 12, alignItems: 'center' }}>
        <div className="search" style={{ flex: 1 }}>
          <Icon name="search" />
          <input className="input" placeholder="Filter skills" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} style={{ accentColor: 'var(--accent)' }} />
          Show all skills
        </label>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Skill</th>
            <th>Type</th>
            <th className="r">Mod</th>
            <th className="r">Total</th>
            <th className="r">Ranks</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((s) => (
            <tr key={s.key}>
              <td className="row-title">
                <button
                  className={'link-btn' + (detail.isOpen(catalogRef(character.id, 'skill', s.key)) ? ' on' : '')}
                  title="Show what this skill does"
                  onClick={() => detail.open(catalogRef(character.id, 'skill', s.key, s.name))}
                >
                  {s.name}
                </button>
              </td>
              <td>{s.cost ? <span className={'chip ' + (s.cost === 'CLASS' ? 'accent' : '')}>{s.cost === 'CLASS' ? 'class' : s.cost.toLowerCase().replace('_', ' ')}</span> : null}</td>
              <td className="r num">{s.modifier != null ? signed(s.modifier) : ''}</td>
              <td className="r num"><b>{s.total ?? ''}</b></td>
              <td className="r">
                <span className="stepper">
                  <button className="btn small icon" aria-label={`Remove a rank of ${s.name}`} disabled={s.ranks <= 0} onClick={() => void spend(s, -1)}>
                    <Icon name="minus" size={14} />
                  </button>
                  <b className="num">{s.ranks}</b>
                  <button className="btn small icon" aria-label={`Add a rank of ${s.name}`} disabled={remaining <= 0} onClick={() => void spend(s, 1)}>
                    <Icon name="plus" size={14} />
                  </button>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {shown.length === 0 && <Empty title="No skills match" />}
    </Card>
  )
}
