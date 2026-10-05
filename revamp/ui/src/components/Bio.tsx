import { useEffect, useState } from 'react'
import * as api from '../api'
import { useStore } from '../store'
import type { Changed, Character, EngineMessage } from '../types'
import { Background } from './Feats'
import { Card, Empty } from './ui'

type Biography = Record<string, string | number | null>

const FIELDS: { key: string; label: string; wide?: boolean }[] = [
  { key: 'skinColor', label: 'Skin' },
  { key: 'hairColor', label: 'Hair colour' },
  { key: 'hairStyle', label: 'Hair style' },
  { key: 'eyeColor', label: 'Eyes' },
  { key: 'height', label: 'Height' },
  { key: 'weight', label: 'Weight' },
  { key: 'speechPattern', label: 'Speech' },
  { key: 'birthday', label: 'Birthday' },
  { key: 'birthplace', label: 'Birthplace' },
  { key: 'city', label: 'Home city' },
  { key: 'location', label: 'Location' },
  { key: 'personalityTrait1', label: 'Personality (1)' },
  { key: 'personalityTrait2', label: 'Personality (2)' },
  { key: 'phobias', label: 'Phobias' },
  { key: 'interests', label: 'Interests' },
  { key: 'catchPhrase', label: 'Catch phrase', wide: true },
]

function Biography({ character }: { character: Character }) {
  const { act, notify, markUnsaved } = useStore()
  const [bio, setBio] = useState<Biography | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const id = encodeURIComponent(character.id)

  useEffect(() => {
    let live = true
    void act(() => api.get<Biography>(`/characters/${id}/biography`)).then((b) => {
      if (live && b) {
        setBio(b)
        setDraft({})
      }
    })
    return () => {
      live = false
    }
  }, [id, act])

  if (!bio) return null
  const value = (k: string) => draft[k] ?? String(bio[k] ?? '')
  const save = async (k: string) => {
    if (draft[k] === undefined || draft[k] === String(bio[k] ?? '')) return
    const res = await act(() => api.patch<{ biography: Biography; messages: EngineMessage[] }>(`/characters/${id}/biography`, { [k]: draft[k] }))
    if (res) {
      markUnsaved(character.id)
      setBio(res.biography)
      setDraft((d) => {
        const n = { ...d }
        delete n[k]
        return n
      })
      res.messages.forEach((m) => notify('warn', m.text))
    }
  }
  return (
    <Card title="Appearance & personality">
      <div className="grid cols-3" style={{ gap: 14 }}>
        {FIELDS.map((f) => (
          <label key={f.key} className="field" style={f.wide ? { gridColumn: '1 / -1' } : undefined}>
            <span>
              {f.label}
              {f.key === 'height' ? ` (${bio.heightUnit})` : f.key === 'weight' ? ` (${String(bio.weightUnit).trim()})` : ''}
            </span>
            <input
              className="input"
              value={value(f.key)}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
              onBlur={() => void save(f.key)}
              onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            />
          </label>
        ))}
        <div className="field">
          <span>Region</span>
          <div className="row-sub" style={{ padding: '8px 0' }}>{String(bio.region ?? '—')}</div>
        </div>
      </div>
    </Card>
  )
}

interface Note {
  index: number
  name: string
  text: string
  builtIn: boolean
}

function Notes({ character }: { character: Character }) {
  const { act, markUnsaved } = useStore()
  const [notes, setNotes] = useState<Note[]>([])
  const [selected, setSelected] = useState(0)
  const [text, setText] = useState('')
  const [title, setTitle] = useState('')
  const id = encodeURIComponent(character.id)

  useEffect(() => {
    let live = true
    void act(() => api.get<Note[]>(`/characters/${id}/notes`)).then((n) => live && n && setNotes(n))
    return () => {
      live = false
    }
  }, [id, act])

  const note = notes[selected]
  useEffect(() => {
    setText(note?.text ?? '')
    setTitle(note?.name ?? '')
  }, [note?.index, note?.text, note?.name])

  const apply = async (call: () => Promise<{ notes: Note[] }>) => {
    const res = await act(call)
    if (res) {
      setNotes(res.notes)
      markUnsaved(character.id)
    }
    return res
  }

  return (
    <Card
      title="Notes"
      action={
        <button
          className="btn small primary"
          onClick={async () => {
            const res = await apply(() => api.post(`/characters/${id}/notes`, { name: 'New note', text: '' }))
            if (res) setSelected(res.notes.length - 1)
          }}
        >
          New note
        </button>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '200px minmax(0, 1fr)', gap: 16 }}>
        <div className="rows" style={{ alignContent: 'start' }}>
          {notes.map((n, i) => (
            <button key={n.index} className={'char-item'} aria-current={i === selected} onClick={() => setSelected(i)}>
              <span className="char-item-text">
                <span className="char-item-name">{n.name}</span>
                <span className="char-item-sub">{n.text ? `${n.text.length} characters` : 'empty'}</span>
              </span>
            </button>
          ))}
        </div>
        {note ? (
          <div style={{ display: 'grid', gap: 10 }}>
            {!note.builtIn && (
              <input
                className="input"
                aria-label="Note title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onBlur={() => title !== note.name && void apply(() => api.patch(`/characters/${id}/notes/${note.index}`, { name: title }))}
              />
            )}
            <textarea
              className="textarea"
              style={{ minHeight: 260 }}
              aria-label="Note text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => text !== note.text && void apply(() => api.patch(`/characters/${id}/notes/${note.index}`, { text }))}
            />
            {!note.builtIn && (
              <div>
                <button
                  className="btn small danger"
                  onClick={async () => {
                    await apply(() => api.del(`/characters/${id}/notes/${note.index}`))
                    setSelected(0)
                  }}
                >
                  Delete note
                </button>
              </div>
            )}
          </div>
        ) : (
          <Empty title="No note selected" />
        )}
      </div>
    </Card>
  )
}

interface LanguageView {
  languages: { name: string; automatic: boolean; removable: boolean; gm?: boolean }[]
  /** Languages a GM could hand out (PCGen's "Add Language" award); absent when the game has no GM awards. */
  gmAvailable?: string[]
  choosers: { index: number; name: string; remaining: number; available: string[]; selected: string[] }[]
}

function Languages({ character }: { character: Character }) {
  const { act, mutate } = useStore()
  const [view, setView] = useState<LanguageView | null>(null)
  const [pick, setPick] = useState('')
  const [gmPick, setGmPick] = useState('')
  const id = encodeURIComponent(character.id)

  useEffect(() => {
    let live = true
    void act(() => api.get<LanguageView>(`/characters/${id}/languages`)).then((v) => live && v && setView(v))
    return () => {
      live = false
    }
  }, [id, character, act])

  if (!view) return null
  const open = view.choosers.filter((c) => c.remaining > 0)
  return (
    <Card title="Languages">
      <div className="badge-row" style={{ paddingBottom: 12 }}>
        {view.languages.map((l) => (
          <span key={l.name} className={'chip ' + (l.automatic && !l.gm ? '' : 'accent')} title={l.gm ? 'Given by the GM' : undefined}>
            {l.name}
            {l.gm && <b style={{ fontSize: 10, letterSpacing: '0.06em' }}>GM</b>}
            {l.gm && (
              <button
                className="btn ghost small"
                style={{ padding: '0 2px' }}
                title={`Take back ${l.name}`}
                aria-label={`Take back ${l.name}`}
                onClick={() => void mutate(() => api.del<Changed>(`/characters/${id}/gm/languages`, { name: l.name }))}
              >
                &times;
              </button>
            )}
            {!l.gm && l.removable && (
              <button
                className="btn ghost small"
                style={{ padding: '0 2px' }}
                title={`Forget ${l.name}`}
                onClick={() => void mutate(() => api.del<Changed>(`/characters/${id}/languages`, { name: l.name }))}
              >
                &times;
              </button>
            )}
          </span>
        ))}
      </div>
      {open.map((c) => (
        <div key={c.index} style={{ display: 'flex', gap: 8, alignItems: 'center', paddingTop: 6 }}>
          <span className="muted" style={{ minWidth: 190 }}>{c.name} ({c.remaining})</span>
          <select className="select" value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Choose a language…</option>
            {c.available.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <button
            className="btn primary"
            disabled={!pick}
            onClick={() => {
              const name = pick
              setPick('')
              void mutate(() => api.post<Changed>(`/characters/${id}/languages`, { chooser: c.index, add: [name] }))
            }}
          >
            Learn
          </button>
        </div>
      ))}
      {open.length === 0 && <div className="muted">No languages left to choose.</div>}
      {view.gmAvailable && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', paddingTop: 10 }}>
          <span className="muted" style={{ minWidth: 190 }}>Given by the GM</span>
          <select className="select" aria-label="Language to give" value={gmPick} onChange={(e) => setGmPick(e.target.value)}>
            <option value="">Choose a language…</option>
            {view.gmAvailable.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <button
            className="btn"
            disabled={!gmPick}
            title="Uses no language choice: PCGen's Add Language award"
            onClick={() => {
              const name = gmPick
              setGmPick('')
              void mutate(() => api.post<Changed>(`/characters/${id}/gm/languages`, { name }))
            }}
          >
            Give
          </button>
        </div>
      )}
    </Card>
  )
}

export function Bio({ character }: { character: Character }) {
  return (
    <div className="grid" style={{ gap: 18 }}>
      <Biography character={character} />
      <Background character={character} />
      <Languages character={character} />
      <Notes character={character} />
    </div>
  )
}
