import { useEffect, useMemo, useState, type ReactNode } from 'react'
import * as api from '../api'
import { useStore } from '../store'
import type { Catalog, Changed, Character } from '../types'
import { InfoBody, type InfoLike } from './InfoBody'
import { Icon, Modal, useDebounced } from './ui'

export interface PickOption {
  id: string
  title: string
  subtitle?: string
  /** Shown dimmed with a tag; it can be read about but not added. */
  unavailable?: boolean
  /** Wording for that tag (default "unavailable"). */
  unavailableTag?: string
  /** A tag for something that can still be added but deserves a heads-up (e.g. "not castable yet"). */
  tag?: string
  /** Shown as an amber notice in the preview when this entry is selected. */
  note?: string
}

/**
 * Browse a list on the left and read what each entry does on the right before adding it. The Add button
 * stays disabled when the engine says the character can't take the selected entry, and the preview says why.
 */
export function PreviewPicker({
  title,
  subtitle,
  options,
  total,
  query,
  onQuery,
  filters,
  loadInfo,
  onAdd,
  onClose,
}: {
  title: string
  subtitle?: string
  /** null while loading */
  options: PickOption[] | null
  total?: number
  query: string
  onQuery(q: string): void
  /** Optional controls shown under the search box (e.g. a level filter). */
  filters?: ReactNode
  loadInfo(id: string): Promise<InfoLike | undefined>
  onAdd(id: string): void
  onClose(): void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [info, setInfo] = useState<InfoLike | null>(null)
  const [loading, setLoading] = useState(false)
  const chosen = useMemo(() => options?.find((o) => o.id === selected) ?? null, [options, selected])
  // Wait for a pause in arrow-key / click browsing before asking the engine.
  const settled = useDebounced(selected, 120)

  useEffect(() => {
    if (!settled) {
      setInfo(null)
      return
    }
    let live = true
    setLoading(true)
    void loadInfo(settled).then((r) => {
      if (!live) return
      setInfo(r ?? null)
      setLoading(false)
    })
    return () => {
      live = false
    }
    // loadInfo is recreated by the parent on every render; the selection is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled])

  const canAdd = !!chosen && !chosen.unavailable && info?.qualified !== false && !loading && info !== null

  return (
    <Modal
      wide
      title={title}
      subtitle={subtitle}
      onClose={onClose}
      footer={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!canAdd}
            onClick={() => {
              if (!selected) return
              onClose()
              onAdd(selected)
            }}
          >
            {chosen ? `Add ${chosen.title}` : 'Add'}
          </button>
        </>
      }
    >
      <div className="split">
        <div className="split-list">
          <div className="search">
            <Icon name="search" />
            <input className="input" autoFocus placeholder="Search" value={query} onChange={(e) => onQuery(e.target.value)} />
          </div>
          {filters}
          <div className="pick-list" role="listbox" aria-label="Choices">
            {options?.map((o) => (
              <button
                key={o.id}
                role="option"
                aria-selected={o.id === selected}
                className={'pick' + (o.unavailable ? ' dim' : '')}
                onClick={() => setSelected(o.id)}
                onDoubleClick={() => {
                  if (!o.unavailable) {
                    onClose()
                    onAdd(o.id)
                  }
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span className="row-title">{o.title}</span>
                  {o.subtitle && <span className="row-sub" style={{ display: 'block' }}>{o.subtitle}</span>}
                </span>
                {o.unavailable && <span className="chip">{o.unavailableTag ?? 'unavailable'}</span>}
                {!o.unavailable && o.tag && <span className="chip bad">{o.tag}</span>}
              </button>
            ))}
            {options && options.length === 0 && <div className="empty">Nothing matches.</div>}
            {!options && (
              <div className="empty">
                <span className="spinner" />
              </div>
            )}
          </div>
          {options && total !== undefined && total > options.length && (
            <p className="muted" style={{ paddingTop: 8 }}>
              Showing {options.length} of {total}. Type to narrow the list.
            </p>
          )}
        </div>
        <div className="split-preview" aria-live="polite">
          {!selected && <div className="empty">Select an entry to read what it does.</div>}
          {selected && loading && !info && (
            <div className="empty">
              <span className="spinner" />
            </div>
          )}
          {selected && info && (
            <>
              <h3 className="preview-title">{info.name}</h3>
              {chosen?.note && <div className="notice warn">{chosen.note}</div>}
              <InfoBody key={selected} info={info} />
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

/** Add a feat, trait or class choice, reading its description first. */
export function AbilityPicker({
  character,
  categoryKey,
  categoryName,
  onClose,
  onAdded,
}: {
  character: Character
  categoryKey: string
  categoryName: string
  onClose(): void
  onAdded?(): void
}) {
  // Favoured class bonuses depend on who you are (race, class) and only change when you take a new class, so
  // show just the ones that apply. Everywhere else the full list is useful for planning, so it stays the default.
  const qualifiedByDefault = /favou?red class bonus/i.test(categoryName)
  const [onlyQualified, setOnlyQualified] = useState(qualifiedByDefault)
  const { act, mutate } = useStore()
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [result, setResult] = useState<Catalog | null>(null)
  const id = encodeURIComponent(character.id)

  useEffect(() => {
    let live = true
    void act(() => api.get<Catalog & { items: (Catalog['items'][number] & { qualified?: boolean })[] }>('/dataset/abilities', { category: categoryKey, q: dq, limit: 80, character: character.id, qualified: onlyQualified })).then(
      (r) => live && r && setResult(r),
    )
    return () => {
      live = false
    }
  }, [categoryKey, dq, character.id, onlyQualified, act])

  const options: PickOption[] | null = result
    ? result.items.map((it) => ({
        id: it.key ?? it.name,
        title: it.name,
        subtitle: it.source,
        unavailable: (it as { qualified?: boolean }).qualified === false,
      }))
    : null

  return (
    <PreviewPicker
      title={`Add to ${categoryName}`}
      options={options}
      total={result?.total}
      query={q}
      onQuery={setQ}
      filters={
        <label className="check-row">
          <input type="checkbox" checked={onlyQualified} onChange={(e) => setOnlyQualified(e.target.checked)} />
          Only show what {character.name || 'this character'} qualifies for
        </label>
      }
      loadInfo={(key) => act(() => api.get<InfoLike>(`/characters/${id}/abilities/info`, { category: categoryKey, name: key }))}
      onAdd={(key) => {
        void mutate(() => api.post<Changed>(`/characters/${id}/abilities`, { category: categoryKey, name: key })).then(() => onAdded?.())
      }}
      onClose={onClose}
    />
  )
}
