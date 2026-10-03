import { useSyncExternalStore } from 'react'

/**
 * Which sections the user has folded away, remembered between visits. A tiny shared store so every card
 * (and the collapse-all buttons) stay in step without prop drilling.
 */
const STORAGE_KEY = 'pcgen.ui.collapsed'
const listeners = new Set<() => void>()

function read(): ReadonlySet<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

let state: ReadonlySet<string> = read()

function commit(next: Set<string>): void {
  state = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]))
  } catch {
    // Private mode or storage full: folding still works for this visit.
  }
  listeners.forEach((l) => l())
}

export function useCollapsed() {
  const current = useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => state,
  )
  return {
    isCollapsed: (key: string) => current.has(key),
    toggle: (key: string) => {
      const n = new Set(state)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      commit(n)
    },
    setMany: (keys: string[], collapsed: boolean) => {
      const n = new Set(state)
      for (const k of keys) {
        if (collapsed) n.add(k)
        else n.delete(k)
      }
      commit(n)
    },
  }
}
