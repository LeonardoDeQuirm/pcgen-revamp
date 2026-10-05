import { useEffect, useRef, useState } from 'react'
import * as api from './api'
import { Attacks } from './components/Attacks'
import { Bio } from './components/Bio'
import { NewCharacterWizard } from './components/NewCharacter'
import { BuilderDialog, ChooserDialog, ConfirmDialog, OpenDialog, SaveAsDialog } from './components/Dialogs'
import { Export } from './components/Export'
import { ClassTab, Feats } from './components/Feats'
import { groupOf } from './components/groups'
import { Gear } from './components/Gear'
import { Overview } from './components/Overview'
import { Skills } from './components/Skills'
import { Spells } from './components/Spells'
import { Icon, initials } from './components/ui'
import { DetailPanel, useDetail } from './detail'
import { useStore } from './store'
import type { Changed, Character } from './types'

const TABS = ['Overview', 'Class', 'Feats', 'Skills', 'Spells', 'Gear', 'Attacks', 'Biography', 'Sheet'] as const
type Tab = (typeof TABS)[number]

function tabFromHash(): Tab {
  const h = decodeURIComponent(window.location.hash.replace(/^#/, ''))
  return (TABS as readonly string[]).includes(h) ? (h as Tab) : 'Overview'
}

/**
 * The engine's to-do items name PCGen's old tab titles and a field (often an ability category). Map them
 * to our tabs, using the same sorting as the Feats / Class / Biography pages.
 */
function tabFor(engineTab: string, field?: string | null, character?: Character): Tab {
  const cat = field ? character?.abilityCategories.find((c) => c.name === field || c.key === field) : undefined
  if (cat && character) {
    const g = groupOf(cat, character)
    return g === 'feats' ? 'Feats' : g === 'class' ? 'Class' : 'Biography'
  }
  const t = engineTab.toLowerCase()
  if (t.includes('feat') || t.includes('abilit')) return 'Feats'
  if (t.includes('skill')) return 'Skills'
  if (t.includes('spell')) return 'Spells'
  if (t.includes('equip') || t.includes('inventory') || t.includes('gear')) return 'Gear'
  if (t.includes('desc') || t.includes('bio') || t.includes('note')) return 'Biography'
  return 'Overview'
}

function Sidebar({ onOpen, onNew }: { onOpen: () => void; onNew: () => void }) {
  const { characters, activeId, select, closeCharacter, health, connection } = useStore()
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <svg viewBox="0 0 24 24"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" /></svg>
        </div>
        <div className="brand-name">PCGen</div>
      </div>
      <div className="sidebar-actions">
        <button className="btn primary" style={{ flex: 1 }} onClick={onOpen}>
          <Icon name="folder" /> Open
        </button>
        <button className="btn" style={{ flex: 1 }} onClick={onNew}>
          <Icon name="plus" /> New
        </button>
      </div>
      <div className="sidebar-label">Characters</div>
      <ul className="char-list">
        {characters.map((c) => (
          <li key={c.id} style={{ position: 'relative' }}>
            <button className="char-item" aria-current={c.id === activeId} onClick={() => select(c.id)}>
              <span className="avatar">{initials(c.name)}</span>
              <span className="char-item-text">
                <span className="char-item-name">{c.name || 'Unnamed'}</span>
                <span className="char-item-sub">{c.file ? c.file.split(/[\\/]/).pop() : 'unsaved'}</span>
              </span>
            </button>
            {c.id === activeId && (
              <button
                className="btn ghost icon small"
                style={{ position: 'absolute', right: 6, top: 12 }}
                title="Close this character"
                aria-label={`Close ${c.name ?? 'character'}`}
                onClick={() => {
                  if (window.confirm('Close this character? Unsaved changes will be lost.')) void closeCharacter(c.id)
                }}
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </li>
        ))}
        {characters.length === 0 && <li className="muted" style={{ padding: '6px 10px' }}>No characters open.</li>}
      </ul>
      <div className="sidebar-foot">
        <div>
          <span className={'status-dot ' + (connection === 'ok' ? 'ok' : connection === 'down' ? 'down' : '')} />
          {connection === 'ok' ? 'Engine ready' : connection === 'down' ? 'Engine offline' : 'Connecting…'}
        </div>
        {health && (
          <div style={{ paddingTop: 4 }} title={health.sources.join(', ')}>
            {health.gameMode.replace('_', ' ')} &middot; {health.sources.length} sources
          </div>
        )}
      </div>
    </aside>
  )
}

function Hero({ character, tab, setTab }: { character: Character; tab: Tab; setTab: (t: Tab) => void }) {
  const { mutate, act, unsaved, markSaved, notify } = useStore()
  const [name, setName] = useState(character.name ?? '')
  const id = encodeURIComponent(character.id)
  useEffect(() => setName(character.name ?? ''), [character.name, character.id])
  const classes = character.classes.map((c) => `${c.class} ${c.level}`).join(' / ')
  const count = (t: Tab) => character.todo.filter((x) => (x.tab ? tabFor(x.tab, x.field, character) : 'Overview') === t).length

  const [saveAs, setSaveAs] = useState(false)
  const save = async () => {
    if (!character.file) return setSaveAs(true) // never saved: ask where
    const res = await act(() => api.post<Changed>(`/characters/${id}/save`, {}))
    if (res) {
      markSaved(character.id)
      notify('info', 'Saved.')
    }
  }

  return (
    <header className="hero">
      {saveAs && (
        <SaveAsDialog
          characterId={character.id}
          suggestedName={character.name ?? ''}
          onClose={() => setSaveAs(false)}
          onSaved={() => {
            setSaveAs(false)
            markSaved(character.id)
            notify('info', 'Saved.')
          }}
        />
      )}
      <div className="hero-top">
        <input
          className="hero-name"
          value={name}
          aria-label="Character name"
          placeholder="Unnamed character"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name !== (character.name ?? '') && void mutate(() => api.patch<Changed>(`/characters/${id}`, { name }))}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        />
        <div className="badge-row">
          {unsaved && <span className="chip warn">Unsaved changes</span>}
          <button className="btn" onClick={() => void save()}>
            Save
          </button>
          <button className="btn ghost" onClick={() => setSaveAs(true)}>
            Save as&hellip;
          </button>
        </div>
      </div>
      <div className="hero-sub">
        {[character.race, classes || 'No levels yet', character.alignment].filter(Boolean).map((p, i) => (
          <span key={i}>
            {i > 0 && <span className="sep">/</span>}
            {p}
          </span>
        ))}
        {character.deity && character.deity !== 'None' ? <span><span className="sep">/</span>{character.deity}</span> : null}
      </div>
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t} role="tab" className="tab" aria-selected={t === tab} onClick={() => setTab(t)}>
            {t}
            {count(t) > 0 && <span className="count num">{count(t)}</span>}
          </button>
        ))}
      </nav>
    </header>
  )
}

function Toasts() {
  const { toasts, dismissToast } = useStore()
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={'toast ' + t.kind} role={t.kind === 'error' ? 'alert' : 'status'}>
          <p>{t.text}</p>
          <button className="btn ghost icon small" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

export default function App() {
  const { character, connection, characters, busy, createCharacter, chooserRequest, builderRequest, confirmRequest } = useStore()
  const [tab, setTab] = useState<Tab>(tabFromHash)
  const [opening, setOpening] = useState(false)
  const [wizardId, setWizardId] = useState<string | null>(null)
  const { closeCharacter } = useStore()
  const startNew = async () => {
    const id = await createCharacter()
    if (id) setWizardId(id)
  }
  const lastId = useRef<string | undefined>(undefined)
  const { detail } = useDetail()

  // Switching to a different character starts on its overview; the first load keeps a deep-linked tab.
  useEffect(() => {
    if (lastId.current !== undefined && character && character.id !== lastId.current) setTab('Overview')
    if (character) lastId.current = character.id
  }, [character])
  useEffect(() => {
    window.history.replaceState(null, '', '#' + tab)
  }, [tab])

  let body
  if (connection !== 'ok') {
    body = (
      <div className="splash">
        <div>
          <h1>{connection === 'connecting' ? 'Starting the engine…' : 'The PCGen engine is not running'}</h1>
          <p className="muted" style={{ maxWidth: 440 }}>
            {connection === 'connecting' ? (
              <span className="spinner" />
            ) : (
              <>Start the sidecar, then this page reconnects by itself. See <b>ui/README.md</b> for the command.</>
            )}
          </p>
        </div>
      </div>
    )
  } else if (!character) {
    body = (
      <div className="splash">
        <div>
          <h1>{characters.length === 0 ? 'Open or create a character' : 'Choose a character'}</h1>
          <p className="muted" style={{ paddingBottom: 18 }}>Pick a saved .pcg file, or start a fresh character.</p>
          <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
            <button className="btn primary" onClick={() => setOpening(true)}>Open a file</button>
            <button className="btn" onClick={() => void startNew()}>New character</button>
          </div>
        </div>
      </div>
    )
  } else {
    body = (
      <>
        <Hero character={character} tab={tab} setTab={setTab} />
        <div className="main-scroll">
          <div className="page">
            {tab === 'Overview' && <Overview character={character} goTo={(t, field) => setTab(tabFor(t, field, character))} />}
            {tab === 'Class' && <ClassTab character={character} />}
            {tab === 'Feats' && <Feats character={character} />}
            {tab === 'Skills' && <Skills character={character} />}
            {tab === 'Spells' && <Spells character={character} />}
            {tab === 'Gear' && <Gear character={character} />}
            {tab === 'Attacks' && <Attacks character={character} />}
            {tab === 'Biography' && <Bio character={character} />}
            {tab === 'Sheet' && <Export character={character} />}
          </div>
        </div>
      </>
    )
  }

  return (
    <div className="app">
      {busy && !builderRequest && <div className="busy-bar" />}
      <Sidebar onOpen={() => setOpening(true)} onNew={() => void startNew()} />
      <main className={'main' + (detail ? ' has-detail' : '')}>{body}</main>
      <DetailPanel />
      {opening && <OpenDialog onClose={() => setOpening(false)} />}
      {wizardId && character && character.id === wizardId && (
        <NewCharacterWizard
          character={character}
          goTo={(t) => setTab(tabFor(t, null, character))}
          onDone={() => setWizardId(null)}
          onCancel={() => {
            setWizardId(null)
            void closeCharacter(wizardId)
          }}
        />
      )}
      {builderRequest && <BuilderDialog />}
      {chooserRequest && <ChooserDialog />}
      {confirmRequest && <ConfirmDialog />}
      <Toasts />
    </div>
  )
}
