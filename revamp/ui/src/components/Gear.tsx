import { useEffect, useState } from 'react'
import * as api from '../api'
import { useStore } from '../store'
import type { Catalog, Changed, Character } from '../types'
import { Card, Icon, useDebounced } from './ui'

interface Owned {
  key: string
  name: string
  quantity: number
  types: string[]
}

interface Slot {
  node: number
  type: string
  name: string
  location: string
  equipment?: string
  quantity?: number
}

interface GearView {
  funds: string
  load: string
  carried: string
  weightLimit: string
  purchased: Owned[]
  sets: string[]
  currentSet: string | null
  slots: Slot[]
}

const COINS = /^(Copper|Silver|Gold|Platinum) Piece$/i

export function Gear({ character }: { character: Character }) {
  const { act, mutate } = useStore()
  const [view, setView] = useState<GearView | null>(null)
  const [q, setQ] = useState('')
  const dq = useDebounced(q)
  const [shop, setShop] = useState<Catalog | null>(null)
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

  if (!view) return <div className="empty"><span className="spinner" /></div>

  const equipped = view.slots.filter((s) => s.type === 'EQUIPMENT')
  const byLocation = new Map<string, Slot[]>()
  for (const s of equipped) byLocation.set(s.location, [...(byLocation.get(s.location) ?? []), s])
  const coins = view.purchased.filter((p) => COINS.test(p.name))
  const gear = view.purchased.filter((p) => !COINS.test(p.name))

  const buy = (key: string, customize: boolean) =>
    mutate(() => api.post<Changed>(`/characters/${id}/equipment/buy`, { item: key, quantity: 1, customize }))
  const sell = (key: string, quantity: number) =>
    mutate(() => api.post<Changed>(`/characters/${id}/equipment/sell`, { item: key, quantity }))
  const equip = (key: string) => mutate(() => api.post<Changed>(`/characters/${id}/equipment/equip`, { item: key }))
  const unequip = (node: number) => mutate(() => api.post<Changed>(`/characters/${id}/equipment/unequip`, { node }))

  return (
    <div className="grid sheet" style={{ gap: 18 }}>
      <div className="grid" style={{ gap: 18 }}>
        <Card title={`Gear · ${gear.length}`}>
          {gear.length === 0 && <div className="muted">Nothing owned yet. Use the shop to buy something.</div>}
          <div className="rows">
            {gear.map((g) => (
              <div key={g.key} className="row">
                <div className="row-main">
                  <div className="row-title">
                    {g.name} {g.quantity > 1 && <span className="muted num">&times;{g.quantity}</span>}
                  </div>
                  <div className="row-sub">{g.types.slice(0, 4).join(' · ')}</div>
                </div>
                <span style={{ display: 'flex', gap: 6 }}>
                  <button className="btn small" onClick={() => void equip(g.key)}>Equip</button>
                  <button className="btn small ghost danger" onClick={() => void sell(g.key, 1)}>Sell</button>
                </span>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Shop">
          <div className="search">
            <Icon name="search" />
            <input className="input" placeholder="Search all equipment (at least 2 letters)" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {shop && (
            <div className="result-list">
              {shop.items.map((it) => (
                <div key={(it.key ?? it.name) + (it.source ?? '')} className="result" style={{ cursor: 'default', alignItems: 'center' }}>
                  <span style={{ minWidth: 0 }}>
                    <span className="row-title">{it.name}</span>
                    <span className="row-sub" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {(it.type ?? '').split('.').slice(0, 4).join(' · ')}
                    </span>
                  </span>
                  <span style={{ display: 'flex', gap: 6 }}>
                    <button className="btn small" onClick={() => void buy(it.key ?? it.name, true)}>Customize</button>
                    <button className="btn small primary" onClick={() => void buy(it.key ?? it.name, false)}>Buy</button>
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
          <div className="vital"><span className="vital-label">Load</span><span className="vital-value">{view.load}</span></div>
          <div className="vital"><span className="vital-label">Carried</span><span className="vital-value num">{view.carried}</span></div>
          <div className="vital"><span className="vital-label">Weight limit</span><span className="vital-value num">{view.weightLimit}</span></div>
        </Card>
        <Card title={view.currentSet ? `Worn & held · ${view.currentSet}` : 'Worn & held'}>
          {byLocation.size === 0 && <div className="muted">Nothing is equipped.</div>}
          {[...byLocation.entries()].map(([loc, items]) => (
            <div key={loc} style={{ paddingBottom: 10 }}>
              <div className="muted" style={{ fontSize: 12, fontWeight: 600, paddingBottom: 2 }}>{loc}</div>
              {items.map((s) => (
                <div key={s.node} className="row" style={{ padding: '5px 2px' }}>
                  <span>{s.equipment}{(s.quantity ?? 1) > 1 ? <span className="muted num"> &times;{s.quantity}</span> : null}</span>
                  <button className="btn small ghost" onClick={() => void unequip(s.node)}>Unequip</button>
                </div>
              ))}
            </div>
          ))}
        </Card>
      </div>
    </div>
  )
}
