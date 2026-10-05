import { useEffect, useState } from 'react'
import * as api from '../api'
import { useStore } from '../store'
import type { Catalog, Changed, Character } from '../types'
import { catalogRef, useDetail } from '../detail'
import { StartingGoldCard } from './StartingGold'
import { Card, Icon, Modal, useDebounced } from './ui'

interface Owned {
  key: string
  name: string
  quantity: number
  types: string[]
  /** Weight and cost of one. */
  weight?: number
  cost?: number
  /** How many are in the current set (worn, wielded or carried). */
  inSet?: number
}

interface Slot {
  node: number
  type: string
  name: string
  location: string
  equipment?: string
  quantity?: number
}

interface LoadInfo {
  carried: number
  unit: string
  bands: { name: string; upTo: number }[]
}

interface GearView {
  funds: string
  load: string
  carried: string
  weightLimit: string
  loadInfo?: LoadInfo
  purchased: Owned[]
  sets: string[]
  currentSet: string | null
  buySellScheme: string | null
  slots: Slot[]
}

interface Place {
  node: number
  location: string
  name: string
  preferred: boolean
}

const COINS = /^(Copper|Silver|Gold|Platinum) Piece$/i

/** Plain-language names for the engine's place names. */
function placeLabel(p: Place): string {
  return p.name && p.name !== p.location ? `${p.location} · ${p.name}` : p.location
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, ''))

/** The weight carried against the light / medium / heavy limits, as one bar. */
function LoadBar({ info, load }: { info: LoadInfo; load: string }) {
  const top = info.bands[info.bands.length - 1]?.upTo ?? 0
  const scale = Math.max(top, info.carried, 1)
  const over = info.carried > top
  return (
    <div style={{ padding: '10px 0 4px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', paddingBottom: 6 }}>
        <span className="muted">Carrying</span>
        <b className="num">
          {fmt(info.carried)} {info.unit} <span className="muted">&middot; {over ? 'overloaded' : load.toLowerCase()}</span>
        </b>
      </div>
      <div className="progress" role="img" aria-label={`${fmt(info.carried)} of ${fmt(top)} ${info.unit} before overloaded`} style={{ position: 'relative' }}>
        <i style={{ width: `${Math.min(100, (info.carried / scale) * 100)}%`, background: over ? 'var(--bad)' : undefined }} />
        {info.bands.slice(0, -1).map((b) => (
          <span key={b.name} style={{ position: 'absolute', top: 0, bottom: 0, left: `${(b.upTo / scale) * 100}%`, width: 2, background: 'var(--bg)' }} />
        ))}
      </div>
      <div className="muted num" style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, paddingTop: 4 }}>
        {info.bands.map((b) => (
          <span key={b.name}>
            {b.name} to {fmt(b.upTo)}
          </span>
        ))}
      </div>
    </div>
  )
}

export function Gear({ character }: { character: Character }) {
  const { act, mutate } = useStore()
  const detail = useDetail()
  const [view, setView] = useState<GearView | null>(null)
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [shop, setShop] = useState<Catalog | null>(null)
  const [schemes, setSchemes] = useState<string[]>([])
  const [qty, setQty] = useState('1')
  const [placing, setPlacing] = useState<{ item: Owned; places: Place[] } | null>(null)
  const id = encodeURIComponent(character.id)

  useEffect(() => {
    let live = true
    void act(() => api.get<GearView>(`/characters/${id}/equipment`)).then((v) => live && v && setView(v))
    return () => {
      live = false
    }
  }, [id, character, act])

  useEffect(() => {
    if (dq.trim().length < 2) {
      setShop(null)
      return
    }
    let live = true
    void act(() => api.get<Catalog>('/dataset/equipment', { q: dq, limit: 30 })).then((r) => live && r && setShop(r))
    return () => {
      live = false
    }
  }, [dq, act])

  useEffect(() => {
    let live = true
    void act(() => api.get<Catalog>('/dataset/gear-buy-sell')).then((r) => live && r && setSchemes(r.items.map((i) => i.name)))
    return () => {
      live = false
    }
  }, [act])

  if (!view) return <div className="empty"><span className="spinner" /></div>

  const count = Math.max(1, Math.min(999, Math.floor(Number(qty)) || 1))
  const equipped = view.slots.filter((s) => s.type === 'EQUIPMENT')
  const byLocation = new Map<string, Slot[]>()
  for (const s of equipped) byLocation.set(s.location, [...(byLocation.get(s.location) ?? []), s])
  const coins = view.purchased.filter((p) => COINS.test(p.name))
  const gear = view.purchased.filter((p) => !COINS.test(p.name))

  const buy = (key: string, customize: boolean) =>
    mutate(() => api.post<Changed>(`/characters/${id}/equipment/buy`, { item: key, quantity: customize ? 1 : count, customize }))
  const sell = (key: string, quantity: number) =>
    mutate(() => api.post<Changed>(`/characters/${id}/equipment/sell`, { item: key, quantity }))
  const unequip = (node: number) => mutate(() => api.post<Changed>(`/characters/${id}/equipment/unequip`, { node }))
  const setScheme = (scheme: string) => mutate(() => api.put<Changed>(`/characters/${id}/equipment/scheme`, { scheme }))

  // Equip: if the item can only go one place, put it there; otherwise ask where (hand, both hands, worn, carried...).
  const equip = async (item: Owned) => {
    const res = await act(() => api.get<{ places: Place[] }>(`/characters/${id}/equipment/where`, { item: item.key }))
    if (!res) return
    if (res.places.length === 0) return void act(() => Promise.reject(new Error(`${item.name} has nowhere to go in this set.`)))
    if (res.places.length === 1) return void mutate(() => api.post<Changed>(`/characters/${id}/equipment/equip`, { item: item.key, node: res.places[0].node }))
    setPlacing({ item, places: [...res.places].sort((a, b) => Number(b.preferred) - Number(a.preferred)) })
  }

  const newSet = () => {
    const name = window.prompt('Name for the new equipment set (for example Travel or Dungeon)? It starts as a copy of the current one.', '')?.trim()
    if (name) void mutate(() => api.post<Changed>(`/characters/${id}/equipment-sets`, { name }))
  }
  const deleteSet = () => {
    const name = view.currentSet
    if (name && window.confirm(`Delete the equipment set "${name}"? The items stay with the character.`))
      void mutate(() => api.del<Changed>(`/characters/${id}/equipment-sets`, { name }))
  }
  const chooseSet = (name: string) => mutate(() => api.put<Changed>(`/characters/${id}/equipment-sets/current`, { name }))

  return (
    <div className="grid sheet" style={{ gap: 18 }}>
      <div className="grid" style={{ gap: 18 }}>
        <StartingGoldCard character={character} />
        <Card title={`Gear · ${gear.length}`}>
          {gear.length === 0 && <div className="muted">Nothing owned yet. Use the shop to buy something.</div>}
          <div className="rows">
            {gear.map((g) => (
              <div key={g.key} className="row">
                <div className="row-main">
                  <div className="row-title">
                    <button className="link-btn" title="Show what this does" onClick={() => detail.open(catalogRef(character.id, 'equipment', g.key, g.name))}>
                      {g.name}
                    </button>{' '}
                    {g.quantity > 1 && <span className="muted num">&times;{g.quantity}</span>}
                  </div>
                  <div className="row-sub">
                    {g.weight != null && (
                      <span className="num">
                        {fmt(g.weight * g.quantity)} {view.loadInfo?.unit ?? 'lbs.'}
                      </span>
                    )}
                    {g.cost != null && g.cost > 0 && <span className="num"> &middot; worth {fmt(g.cost * g.quantity)} gp</span>}
                    {g.types.length > 0 && <span> &middot; {g.types.slice(0, 3).join(' · ')}</span>}
                  </div>
                </div>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  {(g.inSet ?? 0) > 0 && (
                    <span className="chip accent" title="In the current equipment set (worn, held or carried)">
                      in use{(g.inSet ?? 0) > 1 ? ` ×${g.inSet}` : ''}
                    </span>
                  )}
                  <button className="btn small" onClick={() => void equip(g)}>Equip</button>
                  <button className="btn small ghost danger" onClick={() => void sell(g.key, 1)}>Sell</button>
                  {g.quantity > 1 && (
                    <button className="btn small ghost danger" title={`Sell all ${g.quantity}`} onClick={() => void sell(g.key, g.quantity)}>
                      Sell all
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </Card>
        <Card
          title="Shop"
          action={
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13 }}>
              <span className="muted">How many</span>
              <input className="input num" style={{ width: 64 }} inputMode="numeric" aria-label="How many to buy" value={qty} onFocus={(e) => e.currentTarget.select()} onChange={(e) => setQty(e.target.value)} />
            </label>
          }
        >
          <div className="search">
            <Icon name="search" />
            <input className="input" placeholder="Search all equipment (at least 2 letters)" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {shop && (
            <div className="result-list">
              {shop.items.map((it) => (
                <div key={(it.key ?? it.name) + (it.source ?? '')} className="result" style={{ cursor: 'default', alignItems: 'center' }}>
                  <span style={{ minWidth: 0 }}>
                    <button className="link-btn row-title" title="Show what this does" onClick={() => detail.open(catalogRef(character.id, 'equipment', it.key ?? it.name, it.name))}>
                      {it.name}
                    </button>
                    <span className="row-sub" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {(it.type ?? '').split('.').slice(0, 4).join(' · ')}
                    </span>
                  </span>
                  <span style={{ display: 'flex', gap: 6 }}>
                    <button className="btn small" onClick={() => void buy(it.key ?? it.name, true)}>Customize</button>
                    <button className="btn small primary" onClick={() => void buy(it.key ?? it.name, false)}>
                      Buy{count > 1 ? ` ${count}` : ''}
                    </button>
                  </span>
                </div>
              ))}
              {shop.items.length === 0 && <div className="empty">Nothing matches.</div>}
            </div>
          )}
        </Card>
      </div>
      <div className="grid" style={{ gap: 18 }}>
        <Card title="Money & load">
          <div className="vital"><span className="vital-label">Funds</span><span className="vital-value num">{view.funds} gp</span></div>
          {coins.map((c) => (
            <div key={c.key} className="vital"><span className="vital-label">{c.name}s</span><span className="vital-value num">{c.quantity}</span></div>
          ))}
          <label className="field" style={{ padding: '10px 0 4px' }}>
            <span>Prices</span>
            <select className="input" value={view.buySellScheme ?? ''} onChange={(e) => void setScheme(e.target.value)}>
              {schemes.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          {/cashless/i.test(view.buySellScheme ?? '') && (
            <p className="muted" style={{ lineHeight: 1.5, paddingBottom: 6 }}>
              Cashless: buying and selling cost nothing, so add gear freely.
            </p>
          )}
          {view.loadInfo ? (
            <LoadBar info={view.loadInfo} load={view.load} />
          ) : (
            <>
              <div className="vital"><span className="vital-label">Load</span><span className="vital-value">{view.load}</span></div>
              <div className="vital"><span className="vital-label">Carried</span><span className="vital-value num">{view.carried}</span></div>
              <div className="vital"><span className="vital-label">Weight limit</span><span className="vital-value num">{view.weightLimit}</span></div>
            </>
          )}
        </Card>
        <Card
          title="Worn & held"
          action={
            <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {view.sets.length > 1 && (
                <select className="input" style={{ width: 'auto' }} aria-label="Equipment set" value={view.currentSet ?? ''} onChange={(e) => void chooseSet(e.target.value)}>
                  {view.sets.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              )}
              <button className="btn small ghost" title="A set is a loadout: what is worn, held and carried. Make one for travel, one for a fight." onClick={newSet}>
                New set
              </button>
              {view.sets.length > 1 && (
                <button className="btn small ghost danger" onClick={deleteSet}>
                  Delete set
                </button>
              )}
            </span>
          }
        >
          {view.sets.length <= 1 && view.currentSet && <div className="muted" style={{ paddingBottom: 8 }}>Set: {view.currentSet}</div>}
          {byLocation.size === 0 && <div className="muted">Nothing is equipped.</div>}
          {[...byLocation.entries()].map(([loc, items]) => (
            <div key={loc} style={{ paddingBottom: 10 }}>
              <div className="muted" style={{ fontSize: 12, fontWeight: 600, paddingBottom: 2 }}>{loc}</div>
              {items.map((s) => (
                <div key={s.node} className="row" style={{ padding: '5px 2px' }}>
                  <span>
                    <button className="link-btn" title="Show what this does" onClick={() => s.equipment && detail.open(catalogRef(character.id, 'equipment', s.equipment, s.equipment))}>
                      {s.equipment}
                    </button>
                    {(s.quantity ?? 1) > 1 ? <span className="muted num"> &times;{s.quantity}</span> : null}
                  </span>
                  <button className="btn small ghost" onClick={() => void unequip(s.node)}>Unequip</button>
                </div>
              ))}
            </div>
          ))}
        </Card>
      </div>
      {placing && (
        <Modal title={`Equip ${placing.item.name}`} subtitle="Where should it go?" onClose={() => setPlacing(null)} footer={<button className="btn ghost" onClick={() => setPlacing(null)}>Cancel</button>}>
          <div className="choice-list">
            {placing.places.map((p) => (
              <button
                key={p.node}
                className="choice"
                style={{ textAlign: 'left', cursor: 'pointer' }}
                onClick={() => {
                  setPlacing(null)
                  void mutate(() => api.post<Changed>(`/characters/${id}/equipment/equip`, { item: placing.item.key, node: p.node }))
                }}
              >
                <span>
                  {placeLabel(p)}
                  {p.preferred && <span className="chip accent" style={{ marginLeft: 8 }}>usual</span>}
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  )
}
