import { useCallback, useState } from 'react'

/** What the app does about hit points when a level is added. */
export type HpMode = 'ask' | 'roll' | 'average' | 'max'

export const HP_MODES: { value: HpMode; label: string }[] = [
  { value: 'ask', label: 'Ask me each time' },
  { value: 'roll', label: 'Roll automatically' },
  { value: 'average', label: 'Take the average' },
  { value: 'max', label: 'Take the maximum' },
]

const KEY = 'pcgen.ui.hpMode'

export function readHpMode(): HpMode {
  try {
    const v = window.localStorage.getItem(KEY)
    if (v === 'ask' || v === 'roll' || v === 'average' || v === 'max') return v
  } catch {
    /* storage unavailable: use the default */
  }
  return 'ask'
}

export function useHpMode(): [HpMode, (m: HpMode) => void] {
  const [mode, setMode] = useState<HpMode>(readHpMode)
  const set = useCallback((m: HpMode) => {
    setMode(m)
    try {
      window.localStorage.setItem(KEY, m)
    } catch {
      /* ignore */
    }
  }, [])
  return [mode, set]
}
