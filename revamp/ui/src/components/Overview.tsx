import { useState } from 'react'
import * as api from '../api'
import { useStore } from '../store'
import type { Changed, Character, Stat } from '../types'
import { HP_MODES, readHpMode, useHpMode, type HpMode } from '../hpMode'
import { HpDialog } from './HpDialog'
import { Picker } from './Picker'
import { catalogRef, useDetail } from '../detail'
import { Card, Empty, signed } from './ui'

function AbilityTile({ stat, character }: { stat: Stat; character: Character }) {
  const { mutate } = useStore()
  const [draft, setDraft] = useState<string | null>(null)
  const bonus = stat.raceBonus + stat.otherBonus
  const commit = async () => {
    const v = Number(draft)
    setDraft(null)
    if (!Number.isFinite(v) || v === stat.base) return
    await mutate(() => api.put<Changed>(`/characters/${encodeURIComponent(character.id)}/stats/${stat.key}`, { base: Math.round(v) }))
  }
  return (
    <div className="ability" title={stat.name}>
      <div className="ability-key">{stat.key}</div>
      <div className={'ability-mod num ' + (stat.modifier > 0 ? 'pos' : stat.modifier < 0 ? 'neg' : '')}>{signed(stat.modifier)}</div>
      <input
        className="input ability-edit num"
        aria-label={`${stat.name} base score`}
        inputMode="numeric"
        value={draft ?? String(stat.base)}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(null)
            e.currentTarget.blur()
          }
        }}
      />
      <div className="ability-bonus num">
        {bonus !== 0 ? `${signed(bonus)} bonus → ${stat.total}` : ''}
      </div>
    </div>
  )
}

function Levels({ character }: { character: Character }) {
  const { mutate, act, notify } = useStore()
  const detail = useDetail()
  const [hpMode, setHpMode] = useHpMode()
  const [picking, setPicking] = useState(false)
  const [hpLevel, setHpLevel] = useState<number | null>(null)
  const id = encodeURIComponent(character.id)
  const total = character.levels.length
  const applyHp = async (lvl: number, mode: HpMode, die: number) => {
    if (!die) return
    if (mode === 'roll') {
      const res = await act(() => api.post<Changed & { rolled: number }>(`/characters/${id}/levels/${lvl}/hp/roll`, {}))
      if (res) notify('info', `Level ${lvl}: rolled ${res.rolled} on the d${die}.`)
      return
    }
    const rolled = mode === 'max' ? die : Math.floor(die / 2) + 1
    const res = await mutate(() => api.put<Changed>(`/characters/${id}/levels/${lvl}/hp`, { rolled }))
    if (res) notify('info', `Level ${lvl}: took ${mode === 'max' ? 'the maximum' : 'the average'} (${rolled}) on the d${die}.`)
  }
  return (
    <Card
      title={`Levels · ${total}`}
      action={
        <span style={{ display: 'flex', gap: 8 }}>
          {total > 0 && (
            <button
              className="btn small danger"
              onClick={() => {
                if (window.confirm(`Remove level ${total} (${character.levels[total - 1]?.class ?? ''})?`))
                  void mutate(() => api.del<Changed>(`/characters/${id}/levels`))
              }}
            >
              Remove last
            </button>
          )}
          <button className="btn small primary" onClick={() => setPicking(true)}>
            Level up
          </button>
        </span>
      }
    >
      <label className="field" style={{ marginBottom: 12, maxWidth: 260 }}>
        <span>Hit points when you level up</span>
        <select className="input" value={hpMode} onChange={(e) => setHpMode(e.target.value as HpMode)}>
          {HP_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      {total === 0 ? (
        <Empty title="No levels yet">Pick a class to take the first level.</Empty>
      ) : (
        <div>
          {character.levels.map((l) => (
            <div key={l.level} className="level-row">
              <span className="level-num num">{l.level}</span>
              <span className="row-title">
                {l.class ? (
                  <button className="link-btn" title="Show what this class gives" onClick={() => detail.open(catalogRef(character.id, 'class', l.class ?? '', l.class ?? ''))}>
                    {l.class}
                  </button>
                ) : null}
              </span>
              <button
                className="btn ghost small num"
                title={`Rolled ${l.hpRolled}${l.hpBonus ? ` ${signed(l.hpBonus)} from Constitution and bonuses` : ''}. Click to change.`}
                onClick={() => setHpLevel(l.level)}
              >
                {l.hpGained} HP
              </button>
              <span className={'chip num ' + (l.skillPointsRemaining > 0 ? 'warn' : '')}>
                {l.skillPointsRemaining > 0 ? `${l.skillPointsRemaining} skill pts left` : `${l.skillPointsSpent}/${l.skillPointsGained} skill pts`}
              </span>
            </div>
          ))}
        </div>
      )}
      {picking && (
        <Picker
          title="Choose a class"
          subtitle="This adds one level."
          path="/dataset/classes"
          previewKind="class"
          qualifyFilter
          describe={(it) => it.type?.replace('Base.', '').replace('.', ' · ')}
          onClose={() => setPicking(false)}
          onPick={(it) =>
            void mutate(() => api.post<Changed>(`/characters/${id}/levels`, { class: it.key ?? it.name })).then(async (r) => {
              if (!r || r.character.levels.length <= total) return
              const lvl = r.character.levels.length
              const mode = readHpMode()
              // The first level is always the full die (the usual rule); otherwise follow the player's setting.
              if (mode === 'ask' || lvl === 1) return setHpLevel(lvl)
              await applyHp(lvl, mode, r.character.levels[lvl - 1]?.hitDie ?? 0)
            })
          }
        />
      )}
      {hpLevel !== null && <HpDialog character={character} level={hpLevel} onClose={() => setHpLevel(null)} />}
    </Card>
  )
}

function Vitals({ character }: { character: Character }) {
  const { mutate } = useStore()
  const [xpDraft, setXpDraft] = useState('')
  const id = encodeURIComponent(character.id)
  const pct = character.xpForNextLevel > 0 ? Math.min(100, Math.round((character.xp / character.xpForNextLevel) * 100)) : 0
  const addXp = async () => {
    const n = Number(xpDraft)
    setXpDraft('')
    if (!Number.isFinite(n) || n === 0) return
    await mutate(() => api.patch<Changed>(`/characters/${id}`, { addXp: Math.round(n) }))
  }
  return (
    <Card title="Vitals">
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, paddingBottom: 14 }}>
        <div>
          <div className="muted" style={{ fontSize: 12 }}>Hit points</div>
          <div className="big-number num">{character.hp}</div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ textAlign: 'right' }}>
          <div className="muted" style={{ fontSize: 12 }}>Load</div>
          <div className="row-title">{character.load ?? '—'}</div>
        </div>
      </div>
      <div style={{ paddingBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: 6 }}>
          <span className="muted">Experience</span>
          <span className="num">
            {character.xp.toLocaleString()} / {character.xpForNextLevel.toLocaleString()}
          </span>
        </div>
        <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <i style={{ width: pct + '%' }} />
        </div>
        <div style={{ display: 'flex', gap: 8, paddingTop: 10 }}>
          <input
            className="input num"
            placeholder="Add experience"
            inputMode="numeric"
            value={xpDraft}
            onChange={(e) => setXpDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void addXp()}
          />
          <button className="btn" onClick={() => void addXp()} disabled={!xpDraft}>
            Add
          </button>
        </div>
      </div>
      <div className="vital"><span className="vital-label">Funds</span><span className="vital-value num">{character.funds ?? '—'} gp</span></div>
      <div className="vital"><span className="vital-label">Wealth</span><span className="vital-value num">{character.wealth ?? '—'} gp</span></div>
      <div className="vital"><span className="vital-label">Carried</span><span className="vital-value num">{character.carried ?? '—'}</span></div>
      <div className="vital"><span className="vital-label">Weight limit</span><span className="vital-value num">{character.weightLimit ?? '—'}</span></div>
    </Card>
  )
}

function Identity({ character }: { character: Character }) {
  const { mutate } = useStore()
  const detail = useDetail()
  const [picker, setPicker] = useState<null | 'race' | 'deity' | 'alignment'>(null)
  const id = encodeURIComponent(character.id)
  const row = (label: string, value: string | number | null, kind?: 'race' | 'deity' | 'alignment') => (
    <div className="vital">
      <span className="vital-label">{label}</span>
      <span className="vital-value">
        {value === null || value === '' || String(value).startsWith('<') ? (
          '—'
        ) : kind === 'race' || kind === 'deity' ? (
          <button className="link-btn" title="Show details" onClick={() => detail.open(catalogRef(character.id, kind, String(value), String(value)))}>
            {value}
          </button>
        ) : (
          value
        )}
        {kind && (
          <button className="btn small ghost" onClick={() => setPicker(kind)}>
            Change
          </button>
        )}
      </span>
    </div>
  )
  const config = {
    race: { title: 'Choose a race', path: '/dataset/races', field: 'race' },
    deity: { title: 'Choose a deity', path: '/dataset/deities', field: 'deity' },
    alignment: { title: 'Choose an alignment', path: '/dataset/alignments', field: 'alignment' },
  } as const
  return (
    <Card title="Identity">
      {row('Race', character.race, 'race')}
      {row('Alignment', character.alignment, 'alignment')}
      {row('Deity', character.deity, 'deity')}
      {row('Gender', character.gender)}
      {row('Handed', character.handed)}
      {row('Age', character.age ? `${character.age}${character.ageCategory ? ` (${character.ageCategory})` : ''}` : null)}
      {character.templates.length > 0 && row('Templates', character.templates.join(', '))}
      {character.domains.length > 0 && row('Domains', character.domains.map((d) => d.name).join(', '))}
      {picker && (
        <Picker
          title={config[picker].title}
          path={config[picker].path}
          previewKind={picker === 'race' ? 'race' : picker === 'deity' ? 'deity' : undefined}
          onClose={() => setPicker(null)}
          onPick={(it) => void mutate(() => api.patch<Changed>(`/characters/${id}`, { [config[picker].field]: it.key ?? it.name }))}
        />
      )}
    </Card>
  )
}

function Todo({ character, goTo }: { character: Character; goTo: (tab: string, field?: string | null) => void }) {
  if (character.todo.length === 0) {
    return (
      <Card title="Still to do">
        <div className="muted">Nothing outstanding. This character is complete.</div>
      </Card>
    )
  }
  return (
    <Card title="Still to do">
      {character.todo.map((t, i) => (
        <div key={t.key + i} className="todo">
          <span className="todo-dot" />
          <span style={{ flex: 1 }}>
            {t.message.includes('{0}') ? `${t.field ?? 'Selections'} remain to be chosen.` : t.message}
          </span>
          {t.tab && (
            <button className="btn small ghost" onClick={() => goTo(t.tab ?? '', t.field)}>
              {t.tab}
            </button>
          )}
        </div>
      ))}
    </Card>
  )
}

export function Overview({ character, goTo }: { character: Character; goTo: (tab: string, field?: string | null) => void }) {
  return (
    <div className="grid" style={{ gap: 18 }}>
      <div className="abilities">
        {character.stats.map((s) => (
          <AbilityTile key={s.key} stat={s} character={character} />
        ))}
      </div>
      <div className="grid sheet">
        <div className="grid" style={{ gap: 18 }}>
          <Levels character={character} />
          <Todo character={character} goTo={goTo} />
        </div>
        <div className="grid" style={{ gap: 18 }}>
          <Vitals character={character} />
          <Identity character={character} />
        </div>
      </div>
    </div>
  )
}
