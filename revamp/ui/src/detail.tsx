import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import * as api from './api'
import { InfoBody, type InfoLike } from './components/InfoBody'
import { Icon } from './components/ui'
import { useStore } from './store'
import type { Changed } from './types'

/** The kinds of catalog entry the panel can describe besides abilities and spells. */
export type CatalogKind = 'race' | 'class' | 'skill' | 'deity' | 'template' | 'equipment'

const CATALOG_LABEL: Record<CatalogKind, string> = {
  race: 'Race',
  class: 'Class',
  skill: 'Skill',
  deity: 'Deity',
  template: 'Template',
  equipment: 'Equipment',
}

/** A reference to a race, class, skill, deity, template or item, for the side panel. */
export function catalogRef(characterId: string, catKind: CatalogKind, key: string, name?: string): DetailRef {
  return { kind: 'catalog', characterId, catKind, key, name: name ?? key, removable: false }
}

/** Something the side panel can describe: an ability (feat, class feature, trait...), a spell, or a catalog entry. */
export type DetailRef =
  | {
      kind: 'catalog'
      characterId: string
      catKind: CatalogKind
      key: string
      name: string
      removable: false
    }
  | {
      kind: 'ability'
      characterId: string
      categoryKey: string
      categoryName: string
      key: string
      name: string
      /** True when the character chose it and may take it back (not a rule-granted ability). */
      removable: boolean
    }
  | {
      kind: 'spell'
      characterId: string
      className: string
      level: string
      name: string
      /** True for spells on the character's known list. */
      removable: boolean
      /** True when the class can't cast spells of this level yet. */
      uncastable?: boolean
    }

export function idOf(r: DetailRef): string {
  if (r.kind === 'catalog') return `c|${r.characterId}|${r.catKind}|${r.key}`
  return r.kind === 'ability' ? `a|${r.characterId}|${r.categoryKey}|${r.key}` : `s|${r.characterId}|${r.className}|${r.level}|${r.name}`
}

interface DetailCtx {
  detail: DetailRef | null
  /** Opens the panel on this entry, or closes it if it is already showing it. */
  open(ref: DetailRef): void
  close(): void
  isOpen(ref: DetailRef): boolean
}

const Ctx = createContext<DetailCtx | null>(null)

export function DetailProvider({ children }: { children: ReactNode }) {
  const [detail, setDetail] = useState<DetailRef | null>(null)
  const close = useCallback(() => setDetail(null), [])
  const value = useMemo<DetailCtx>(
    () => ({
      detail,
      open: (ref) => setDetail((cur) => (cur && idOf(cur) === idOf(ref) ? null : ref)),
      close,
      isOpen: (ref) => !!detail && idOf(detail) === idOf(ref),
    }),
    [detail, close],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useDetail(): DetailCtx {
  const c = useContext(Ctx)
  if (!c) throw new Error('useDetail outside DetailProvider')
  return c
}

/** Fetches the description of a ref from the engine. */
export function infoRoute(ref: DetailRef): { path: string; query: Record<string, string> } {
  const id = encodeURIComponent(ref.characterId)
  if (ref.kind === 'catalog') return { path: `/characters/${id}/info`, query: { kind: ref.catKind, name: ref.key } }
  return ref.kind === 'ability'
    ? { path: `/characters/${id}/abilities/info`, query: { category: ref.categoryKey, name: ref.key } }
    : { path: `/characters/${id}/spells/info`, query: { class: ref.className, level: ref.level, spell: ref.name } }
}

/** Side panel with the full text of the selected entry. */
export function DetailPanel() {
  const { detail, close } = useDetail()
  const { act, mutate, character } = useStore()
  const [info, setInfo] = useState<InfoLike | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!detail) return
    let live = true
    setLoading(true)
    const { path, query } = infoRoute(detail)
    void act(() => api.get<InfoLike>(path, query)).then((r) => {
      if (!live) return
      setInfo(r ?? null)
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [detail, act])

  useEffect(() => {
    if (!detail) return
    const h = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [detail, close])

  // Switching character closes the panel (it described the other one's entries).
  useEffect(() => {
    if (detail && character && detail.characterId !== character.id) close()
  }, [character, detail, close])

  if (!detail) return null

  const remove = () => {
    if (!detail.removable) return
    const id = encodeURIComponent(detail.characterId)
    const call =
      detail.kind === 'ability'
        ? () => api.del<Changed>(`/characters/${id}/abilities`, { category: detail.categoryKey, name: detail.key })
        : () => api.del<Changed>(`/characters/${id}/spells/known`, { class: detail.className, level: detail.level, spell: detail.name })
    void mutate(call).then((r) => r && close())
  }

  return (
    <aside className="detail" role="complementary" aria-label={`About ${detail.name}`}>
      <div className="detail-head">
        <div style={{ minWidth: 0 }}>
          <h2>{info?.name ?? detail.name}</h2>
          <div className="detail-sub">
            {detail.kind === 'catalog' ? (
              <span className="chip accent">{CATALOG_LABEL[detail.catKind]}</span>
            ) : detail.kind === 'ability' ? (
              <span className="chip accent">{detail.categoryName}</span>
            ) : (
              <>
                <span className="chip accent">{detail.className}</span>
                <span className="chip num">Level {detail.level}</span>
                {detail.uncastable && <span className="chip bad">can&rsquo;t cast yet</span>}
              </>
            )}
          </div>
        </div>
        <button className="btn ghost icon" aria-label="Close details" onClick={close}>
          <Icon name="close" />
        </button>
      </div>
      <div className="detail-body">
        {loading && !info && (
          <div className="empty">
            <span className="spinner" />
          </div>
        )}
        {info && <InfoBody key={idOf(detail)} info={info} />}
      </div>
      {detail.removable && (
        <div className="detail-foot">
          <button className="btn danger" onClick={remove}>
            {detail.kind === 'spell' ? 'Remove from known spells' : 'Remove from character'}
          </button>
        </div>
      )}
    </aside>
  )
}
