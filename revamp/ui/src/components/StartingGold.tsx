import { useEffect, useState } from 'react'
import * as api from '../api'
import { useStore } from '../store'
import type { Changed, Character } from '../types'
import { Card } from './ui'

interface KitList {
  available: { key: string; name: string; applied: boolean; qualified: boolean }[]
}

/**
 * Starting gold: the rules data has it as a kit that is on offer to a first-level character. Taking it asks how
 * (roll for it, the maximum or the average) and adds the money to the character's funds.
 */
export function useStartingGold(character: Character) {
  const { act, mutate, notify } = useStore()
  const [kit, setKit] = useState<string | null>(null)
  const id = encodeURIComponent(character.id)

  useEffect(() => {
    let live = true
    void act(() => api.get<KitList>(`/characters/${id}/kits`)).then((r) => {
      if (!live) return
      setKit(r?.available.find((k) => /starting gold/i.test(k.name) && k.qualified && !k.applied)?.key ?? null)
    })
    return () => {
      live = false
    }
  }, [id, character, act])

  const take = async () => {
    if (!kit) return
    const funds = Number(character.funds ?? 0)
    if (funds > 0 && !window.confirm(`${character.name || 'This character'} already has ${character.funds} gp. Starting gold is added on top of that. Continue?`)) return
    const before = character.funds
    const res = await mutate(() => api.post<Changed & { fundsAfter?: string }>(`/characters/${id}/kits`, { kit }))
    if (res?.fundsAfter !== undefined && res.fundsAfter !== before) notify('info', `Starting gold added: now ${res.fundsAfter} gp.`)
    else if (res) notify('warn', 'No starting gold was added.')
  }
  return { available: kit !== null, take }
}

export function StartingGoldCard({ character }: { character: Character }) {
  const gold = useStartingGold(character)
  if (!gold.available) return null
  return (
    <Card title="Starting gold">
      <p className="muted" style={{ lineHeight: 1.5, paddingBottom: 12 }}>
        A first-level character gets money to equip with. You can roll for it, take the maximum, or take the average.
      </p>
      <button className="btn primary" onClick={() => void gold.take()}>
        Get starting gold
      </button>
    </Card>
  )
}
