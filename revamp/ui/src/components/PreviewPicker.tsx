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
  addLabel = 'Add',
  extra,
  blocked,
  onSelect,
  override,
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
  /** Verb on the confirm button ("Add" for feats and spells, "Choose" for a race). */
  addLabel?: string
  /** Extra controls shown in the reading pane for the selected entry (e.g. metamagic feats to apply). */
  extra?(selectedId: string): ReactNode
  /** A reason the selected entry cannot be added with the current extra choices (disables Add and says why). */
  blocked?(selectedId: string): string | null
  onSelect?(id: string | null): void
  /** Allow adding even what the engine says the character cannot take (a GM's gift); the reason is shown as a note. */
  override?: boolean
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

  const blockedReason = selected && blocked ? blocked(selected) : null
  const canAdd = !!chosen && (override || (!chosen.unavailable && info?.qualified !== false)) && !loading && info !== null && !blockedReason

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
            {chosen ? `${addLabel} ${chosen.title}` : addLabel}
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
                className={'pick' + (o.unavailable && !override ? ' dim' : '')}
                onClick={() => {
                  setSelected(o.id)
                  onSelect?.(o.id)
                }}
                onDoubleClick={() => {
                  if (!o.unavailable || override) {
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
              {override && info.reason && <div className="notice warn">Normally {info.reason.charAt(0).toLowerCase() + info.reason.slice(1)} As a GM gift it ignores that.</div>}
              {extra?.(selected)}
              {blockedReason && <div className="notice bad">{blockedReason}</div>}
              <InfoBody key={selected} info={override ? { ...info, reason: null } : info} />
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
  // A GM can hand a character any feat: no prerequisites, no feat slot. It is saved with the character and the sheet
  // marks it "(GM)". Only feats can be given this way.
  const [gm, setGm] = useState(false)
  // A feat from the GM still takes a feat slot in PCGen; the GM's "+1 Bonus Feat" award gives the slot back. On by default
  // so a gift costs the character nothing; the choice is remembered.
  const [slot, setSlot] = useState(() => {
    try {
      return window.localStorage.getItem('pcgen.ui.gmFeatSlot') !== 'no'
    } catch {
      return true
    }
  })
  const rememberSlot = (v: boolean) => {
    setSlot(v)
    try {
      window.localStorage.setItem('pcgen.ui.gmFeatSlot', v ? 'yes' : 'no')
    } catch {
      /* ignore */
    }
  }
  const canGm = categoryKey === 'FEAT'
  const { act, mutate } = useStore()
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [result, setResult] = useState<Catalog | null>(null)
  const id = encodeURIComponent(character.id)

  useEffect(() => {
    let live = true
    void act(() => api.get<Catalog & { items: (Catalog['items'][number] & { qualified?: boolean })[] }>('/dataset/abilities', { category: categoryKey, q: dq, limit: 80, character: character.id, qualified: onlyQualified && !gm })).then(
      (r) => live && r && setResult(r),
    )
    return () => {
      live = false
    }
  }, [categoryKey, dq, character.id, onlyQualified, gm, act])

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
      title={gm ? `Add a GM-granted ${categoryName.toLowerCase()}` : `Add to ${categoryName}`}
      override={gm}
      addLabel={gm ? 'Grant' : 'Add'}
      options={options}
      total={result?.total}
      query={q}
      onQuery={setQ}
      filters={
        <>
          {canGm && (
            <label className="check-row" title="Handed out by the GM (PCGen's GM award): ignores prerequisites, and the sheet marks it (GM)">
              <input type="checkbox" checked={gm} onChange={(e) => setGm(e.target.checked)} />
              Granted by the GM (ignores prerequisites)
            </label>
          )}
          {canGm && gm && (
            <label className="check-row" style={{ paddingLeft: 22 }} title="PCGen's +1 Bonus Feat award: one more feat slot, so the new feat does not use up a regular one">
              <input type="checkbox" checked={slot} onChange={(e) => rememberSlot(e.target.checked)} />
              Also give a bonus feat slot for it
            </label>
          )}
          {!gm && (
            <label className="check-row">
              <input type="checkbox" checked={onlyQualified} onChange={(e) => setOnlyQualified(e.target.checked)} />
              Only show what {character.name || 'this character'} qualifies for
            </label>
          )}
        </>
      }
      loadInfo={(key) => act(() => api.get<InfoLike>(`/characters/${id}/abilities/info`, { category: categoryKey, name: key }))}
      onAdd={(key) => {
        void mutate(() => api.post<Changed>(`/characters/${id}/abilities`, { category: categoryKey, name: key, ...(gm ? { gm: true, slot } : {}) })).then(() => onAdded?.())
      }}
      onClose={onClose}
    />
  )
}
