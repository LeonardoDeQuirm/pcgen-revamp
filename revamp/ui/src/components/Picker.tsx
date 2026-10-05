import { useEffect, useState } from 'react'
import * as api from '../api'
import { useStore } from '../store'
import type { Catalog, CatalogItem } from '../types'
import type { CatalogKind } from '../detail'
import { PreviewPicker } from './PreviewPicker'
import type { InfoLike } from './InfoBody'
import { Icon, Modal, useDebounced } from './ui'

/** Search a catalog from the loaded rules data (races, classes, feats, equipment...) and pick one entry. */
export function Picker({
  title,
  subtitle,
  path,
  query,
  onPick,
  onClose,
  describe,
  previewKind,
  qualifyFilter,
}: {
  title: string
  subtitle?: string
  /** Catalog route, e.g. /dataset/races */
  path: string
  query?: Record<string, string>
  onPick: (item: CatalogItem) => void
  onClose: () => void
  describe?: (item: CatalogItem) => string | undefined
  /** When set, the list gets a reading pane: what each race, class, deity... does before you pick it. */
  previewKind?: CatalogKind
  /** Offer "only what this character qualifies for" (on by default); others are dimmed, with the reason in the pane. */
  qualifyFilter?: boolean
}) {
  const { act, character } = useStore()
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [result, setResult] = useState<Catalog | null>(null)
  const [onlyQualified, setOnlyQualified] = useState(true)

  useEffect(() => {
    let live = true
    void act(() => api.get<Catalog>(path, { ...query, q: dq, limit: 80, ...(qualifyFilter && character ? { character: character.id, qualified: onlyQualified } : {}) })).then((r) => live && r && setResult(r))
    return () => {
      live = false
    }
    // query is a fresh object each render; its content is part of `path` for our purposes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, dq, act, JSON.stringify(query), qualifyFilter, onlyQualified, character?.id])

  if (previewKind && character) {
    const cid = encodeURIComponent(character.id)
    // The data's "<none selected>" placeholder is not a choice.
    const items = (result?.items ?? []).filter((i) => !i.name.startsWith('<'))
    return (
      <PreviewPicker
        title={title}
        subtitle={subtitle}
        options={
          result
            ? items.map((it) => ({
                id: it.key ?? it.name,
                title: it.name,
                subtitle: describe?.(it) ?? it.source,
                unavailable: (it as { qualified?: boolean }).qualified === false,
                unavailableTag: 'requirements not met',
              }))
            : null
        }
        filters={
          qualifyFilter ? (
            <label className="check-row">
              <input type="checkbox" checked={onlyQualified} onChange={(e) => setOnlyQualified(e.target.checked)} />
              Only show what {character.name || 'this character'} qualifies for
            </label>
          ) : undefined
        }
        total={result?.total}
        query={q}
        onQuery={setQ}
        loadInfo={(key) => act(() => api.get<InfoLike>(`/characters/${cid}/info`, { kind: previewKind, name: key }))}
        addLabel="Choose"
        onAdd={(key) => {
          const it = items.find((i) => (i.key ?? i.name) === key)
          if (it) onPick(it)
        }}
        onClose={onClose}
      />
    )
  }

  return (
    <Modal
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={<button className="btn ghost" onClick={onClose}>Cancel</button>}
    >
      <div className="search">
        <Icon name="search" />
        <input className="input" autoFocus placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="result-list" style={{ marginBottom: 18 }}>
        {result?.items.map((it) => (
          <button
            key={(it.key ?? it.name) + (it.source ?? '')}
            className="result"
            onClick={() => {
              onClose()
              onPick(it)
            }}
          >
            <span>
              <span className="row-title">{it.name}</span>
              <span className="row-sub" style={{ display: 'block' }}>{describe?.(it) ?? it.source ?? ''}</span>
            </span>
          </button>
        ))}
        {result && result.items.length === 0 && <div className="empty">Nothing matches &ldquo;{q}&rdquo;.</div>}
        {!result && (
          <div className="empty">
            <span className="spinner" />
          </div>
        )}
      </div>
      {result && result.total > result.items.length && (
        <p className="muted" style={{ paddingBottom: 14 }}>
          Showing {result.items.length} of {result.total}. Type to narrow the list.
        </p>
      )}
    </Modal>
  )
}
