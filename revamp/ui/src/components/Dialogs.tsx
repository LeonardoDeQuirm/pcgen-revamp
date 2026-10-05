import { useEffect, useMemo, useState } from 'react'
import * as api from '../api'
import { useDialogBridge, useStore } from '../store'
import type { BuilderState, Catalog, Changed, FileListing } from '../types'
import { Icon, Modal, useDebounced } from './ui'

/** The engine stopped mid-change and wants the user to pick something (a feat's school, an ability to raise...). */
export function ChooserDialog() {
  const { chooserRequest } = useStore()
  const { resolveChooser } = useDialogBridge()
  const chooser = chooserRequest?.chooser
  const [picked, setPicked] = useState<number[]>([])
  const [dropped, setDropped] = useState<number[]>([])
  const [filter, setFilter] = useState('')

  useEffect(() => {
    setPicked([])
    setDropped([])
    setFilter('')
  }, [chooser?.id])

  if (!chooser) return null
  const need = Math.max(chooser.choicesRequired, 0)
  const single = need === 1 && chooser.alreadySelected.length === 0
  // The engine's titles can be whole sentences ("Choose the ability score... If you Cancel you can..."):
  // keep the first sentence as the heading and move the rest into the subtitle.
  const plain = chooser.title.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
  const cut = plain.search(/[.!?]\s+[A-Z]/)
  const heading = cut > 0 ? plain.slice(0, cut + 1) : plain
  const goldChoice = /starting gold/i.test(heading)
  const title = goldChoice ? 'How do you want your starting gold?' : heading
  // The data names these three choices after the book; say what they mean.
  const label = (n: string) => {
    const m = goldChoice ? /~\s*(Random|Maximum|Average)\s*$/i.exec(n) : null
    return m ? { random: 'Roll for it', maximum: 'Take the maximum', average: 'Take the average' }[m[1].toLowerCase()] ?? n : n
  }
  const note = cut > 0 ? plain.slice(cut + 2) : ''
  const options = chooser.options.filter((o) => o.name.toLowerCase().includes(filter.toLowerCase()))
  // Removing something frees a slot, which lets the user pick a replacement in the same step.
  const slots = need + dropped.length
  const complete = chooser.requireCompleteSelection ? picked.length === slots : picked.length <= slots

  const toggle = (i: number) =>
    setPicked((p) => (p.includes(i) ? p.filter((x) => x !== i) : single ? [i] : p.length < slots ? [...p, i] : p))
  const toggleDrop = (i: number) => {
    setDropped((d) => (d.includes(i) ? d.filter((x) => x !== i) : [...d, i]))
    setPicked((p) => p.slice(0, need + (dropped.includes(i) ? dropped.length - 1 : dropped.length + 1)))
  }

  return (
    <Modal
      title={title}
      subtitle={
        <>
          {slots > 0 ? `Choose ${slots === 1 ? 'one' : slots}${picked.length ? ` · ${picked.length} selected` : ''}` : 'Review your selections'}
          {note ? <span style={{ display: 'block' }}>{note}</span> : null}
        </>
      }
      footer={
        <>
          <button className="btn ghost" onClick={() => resolveChooser({ cancel: true })}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!complete}
            onClick={() => resolveChooser({ select: picked, deselect: dropped })}
          >
            Confirm
          </button>
        </>
      }
    >
      {chooser.alreadySelected.length > 0 && (
        <div className="choice-list">
          <div className="muted">Currently chosen — tap to remove</div>
          {chooser.alreadySelected.map((o) => (
            <label key={o.index} className="choice" data-on={dropped.includes(o.index)}>
              <input type="checkbox" checked={dropped.includes(o.index)} onChange={() => toggleDrop(o.index)} />
              <span>{o.name}</span>
            </label>
          ))}
        </div>
      )}
      {chooser.options.length > 12 && (
        <div className="search" style={{ margin: '4px 0 8px' }}>
          <Icon name="search" />
          <input className="input" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      )}
      <div className="choice-list">
        {options.map((o) => (
          <label key={o.index} className="choice" data-on={picked.includes(o.index)}>
            <input
              type={single ? 'radio' : 'checkbox'}
              name="choice"
              checked={picked.includes(o.index)}
              onChange={() => toggle(o.index)}
            />
            <span>{label(o.name)}</span>
          </label>
        ))}
        {options.length === 0 && <div className="muted">Nothing matches.</div>}
      </div>
    </Modal>
  )
}

/** Browse folders on this computer for a .pcg character file. */
export function OpenDialog({ onClose }: { onClose: () => void }) {
  const { openPath, act } = useStore()
  const [listing, setListing] = useState<FileListing | null>(null)
  const [dir, setDir] = useState<string>('')

  useEffect(() => {
    let live = true
    void act(() => api.get<FileListing>('/files', { dir })).then((l) => live && l && setListing(l))
    return () => {
      live = false
    }
  }, [dir, act])

  return (
    <Modal title="Open a character" subtitle="Choose a .pcg file" onClose={onClose} wide footer={<button className="btn ghost" onClick={onClose}>Close</button>}>
      {listing && (
        <>
          <div className="file-path">
            <button className="btn small icon" title="Up one folder" disabled={!listing.parent} onClick={() => listing.parent && setDir(listing.parent)}>
              <Icon name="up" />
            </button>
            <button className="btn small" onClick={() => setDir(listing.home)}>Home</button>
            {listing.roots.map((r) => (
              <button key={r} className="btn small" onClick={() => setDir(r)}>{r}</button>
            ))}
            <span className="muted num" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{listing.dir}</span>
          </div>
          <div className="file-list">
            {listing.entries.map((f) => (
              <button
                key={f.path}
                className="file"
                onClick={() => {
                  if (f.type === 'dir') setDir(f.path)
                  else {
                    onClose()
                    void openPath(f.path)
                  }
                }}
              >
                <Icon name={f.type === 'dir' ? 'folder' : 'file'} />
                <span style={{ flex: 1 }}>{f.name}</span>
                {f.type === 'pcg' && <span className="chip accent">Open</span>}
              </button>
            ))}
            {listing.entries.length === 0 && <div className="empty">No folders or .pcg files here.</div>}
          </div>
        </>
      )}
      {!listing && (
        <div className="empty">
          <span className="spinner" />
        </div>
      )}
    </Modal>
  )
}

const SAVE_DIR_KEY = 'pcgen.ui.saveDir'

/** Choose a folder and a file name for a character. Replacing an existing file asks first. */
export function SaveAsDialog({ characterId, suggestedName, onClose, onSaved }: { characterId: string; suggestedName: string; onClose: () => void; onSaved: () => void }) {
  const { act } = useStore()
  const [listing, setListing] = useState<FileListing | null>(null)
  const [dir, setDir] = useState<string>(() => {
    try {
      return window.localStorage.getItem(SAVE_DIR_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [fileName, setFileName] = useState(() => suggestedName.replace(/[\\/:*?"<>|]+/g, '').trim() || 'character')

  useEffect(() => {
    let live = true
    void act(() => api.get<FileListing>('/files', { dir })).then((l) => live && l && setListing(l))
    return () => {
      live = false
    }
  }, [dir, act])

  const finalName = /\.pcg$/i.test(fileName.trim()) ? fileName.trim() : `${fileName.trim()}.pcg`
  const sep = listing?.dir.includes('\\') ? '\\' : '/'
  const target = listing ? `${listing.dir.replace(/[\\/]$/, '')}${sep}${finalName}` : ''
  const exists = !!listing?.entries.some((f) => f.type === 'pcg' && f.name.toLowerCase() === finalName.toLowerCase())

  const save = async () => {
    if (!listing || !fileName.trim()) return
    if (exists && !window.confirm(`${finalName} already exists in this folder. Replace it?`)) return
    const res = await act(() => api.post<Changed>(`/characters/${encodeURIComponent(characterId)}/save`, { path: target }))
    if (!res) return
    try {
      window.localStorage.setItem(SAVE_DIR_KEY, listing.dir)
    } catch {
      /* ignore */
    }
    onSaved()
  }

  return (
    <Modal
      title="Save character"
      subtitle="Choose a folder, then a file name"
      onClose={onClose}
      wide
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!listing || !fileName.trim()} onClick={() => void save()}>
            {exists ? 'Replace' : 'Save'}
          </button>
        </>
      }
    >
      {listing && (
        <>
          <div className="file-path">
            <button className="btn small icon" title="Up one folder" disabled={!listing.parent} onClick={() => listing.parent && setDir(listing.parent)}>
              <Icon name="up" />
            </button>
            <button className="btn small" onClick={() => setDir(listing.home)}>Home</button>
            {listing.roots.map((r) => (
              <button key={r} className="btn small" onClick={() => setDir(r)}>{r}</button>
            ))}
            <span className="muted num" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{listing.dir}</span>
          </div>
          <div className="file-list">
            {listing.entries.map((f) => (
              <button
                key={f.path}
                className="file"
                onClick={() => (f.type === 'dir' ? setDir(f.path) : setFileName(f.name))}
              >
                <Icon name={f.type === 'dir' ? 'folder' : 'file'} />
                <span style={{ flex: 1 }}>{f.name}</span>
              </button>
            ))}
            {listing.entries.length === 0 && <div className="empty">No folders or .pcg files here yet.</div>}
          </div>
          <label className="field" style={{ marginTop: 14 }}>
            <span>File name</span>
            <input
              className="input"
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void save()}
            />
          </label>
          {exists && <p className="muted" style={{ marginTop: 8 }}>A file with this name is already here and will be replaced.</p>}
        </>
      )}
      {!listing && (
        <div className="empty">
          <span className="spinner" />
        </div>
      )}
    </Modal>
  )
}

/** Customise an item: enchantments, materials, size, name. Edits go straight to the engine; commit or cancel ends it. */
export function BuilderDialog() {
  const { builderRequest, act } = useStore()
  const { resolveBuilder } = useDialogBridge()
  const initial = builderRequest?.builder
  const [state, setState] = useState<BuilderState | null>(initial ?? null)
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [found, setFound] = useState<Catalog | null>(null)
  const [name, setName] = useState('')
  const [head, setHead] = useState('PRIMARY')

  useEffect(() => {
    setState(initial ?? null)
    setName(initial?.name ?? '')
    setQ('')
    setHead('PRIMARY')
  }, [initial?.id, initial])

  useEffect(() => {
    if (!initial) return
    let live = true
    void api
      .get<Catalog>('/builder/modifiers', { q: dq, limit: 40, head })
      .then((c) => live && setFound(c))
      .catch(() => live && setFound(null))
    return () => {
      live = false
    }
  }, [initial, dq, head, state])

  const heads = useMemo(() => Object.keys(state?.heads ?? {}), [state])
  if (!initial || !state) return null

  const finish = async (path: string, body?: unknown) => {
    const res = await act(() => api.request('POST', path, body))
    if (res) resolveBuilder(res)
  }
  const edit = async (method: string, path: string, body?: unknown) => {
    const res = await act(() => api.request(method, path, body))
    if (res && res.status < 400) setState(res.data as BuilderState)
  }

  const applied = state.heads[head]?.applied ?? []

  return (
    <Modal
      wide
      title={`Customize ${state.baseItem}`}
      subtitle="Add materials and enchantments, then buy it."
      footer={
        <>
          <button className="btn ghost" onClick={() => void finish('/builder/cancel')}>Cancel</button>
          <button className="btn" onClick={() => void finish('/builder/commit', { purchase: false })}>Save to item list</button>
          <button className="btn primary" onClick={() => void finish('/builder/commit', { purchase: true })}>Buy</button>
        </>
      }
    >
      <div className="grid cols-2" style={{ paddingBottom: 16 }}>
        <div className="field">
          <span>Name</span>
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name !== state.name && void edit('PATCH', '/builder', { name })}
          />
        </div>
        <div className="field">
          <span>{state.weapon ? `Damage ${state.damage ?? ''}` : 'Item'}</span>
          <div className="row-sub" style={{ paddingTop: 8 }}>
            {state.size ? `Size ${state.size}` : ''}
            {state.resizable ? ' · resizable' : ''}
          </div>
        </div>
      </div>
      {heads.length > 1 && (
        <div className="badge-row" style={{ paddingBottom: 10 }}>
          {heads.map((h) => (
            <button key={h} className={'btn small' + (h === head ? ' primary' : '')} onClick={() => setHead(h)}>
              {h === 'PRIMARY' ? 'Primary end' : 'Secondary end'}
            </button>
          ))}
        </div>
      )}
      <div className="card-title"><span>Applied</span></div>
      <div className="badge-row" style={{ paddingBottom: 14 }}>
        {applied.length === 0 && <span className="muted">Nothing yet</span>}
        {applied.map((m) => (
          <span key={m} className="chip accent">
            {m}
            <button className="btn ghost icon small" style={{ padding: 0 }} title="Remove" onClick={() => void edit('DELETE', `/builder/modifiers?name=${encodeURIComponent(m)}&head=${head}`)}>
              <Icon name="close" size={12} />
            </button>
          </span>
        ))}
      </div>
      <div className="card-title"><span>Available</span></div>
      <div className="search">
        <Icon name="search" />
        <input className="input" placeholder="Search enchantments and materials" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="result-list" style={{ marginBottom: 16 }}>
        {found?.items.map((m) => (
          <button key={m.key ?? m.name} className="result" onClick={() => void edit('POST', '/builder/modifiers', { name: m.key ?? m.name, head })}>
            <span>{m.name}</span>
            <Icon name="plus" />
          </button>
        ))}
        {found && found.items.length === 0 && <div className="empty">No matches.</div>}
      </div>
    </Modal>
  )
}

/** A yes/no question from the engine, e.g. before the first level: "Are your abilities set as you'd like them?" */
export function ConfirmDialog() {
  const { confirmRequest } = useStore()
  const { resolveConfirm } = useDialogBridge()
  if (!confirmRequest) return null
  const { title, message } = confirmRequest.confirm
  return (
    <Modal
      title={title}
      onClose={() => resolveConfirm(false)}
      footer={
        <>
          <button className="btn ghost" onClick={() => resolveConfirm(false)}>
            Go back
          </button>
          <button className="btn primary" autoFocus onClick={() => resolveConfirm(true)}>
            Continue
          </button>
        </>
      }
    >
      <p style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6, paddingBottom: 14 }}>{message}</p>
    </Modal>
  )
}
