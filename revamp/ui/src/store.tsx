import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as api from './api'
import { ApiError } from './api'
import type {
  BuilderState,
  Changed,
  Character,
  CharacterSummary,
  ChooserAnswer,
  EngineMessage,
  Health,
  PendingChooser,
  PendingConfirm,
} from './types'

export interface Toast {
  id: number
  kind: 'info' | 'warn' | 'error'
  text: string
}

interface ChooserRequest {
  chooser: PendingChooser
  resolve: (a: ChooserAnswer) => void
}

interface ConfirmRequest {
  confirm: PendingConfirm
  resolve: (ok: boolean) => void
}

interface BuilderRequest {
  builder: BuilderState
  resolve: (r: api.RawResponse) => void
}

interface Store {
  health: Health | null
  connection: 'connecting' | 'ok' | 'down'
  characters: CharacterSummary[]
  activeId: string | null
  character: Character | null
  busy: boolean
  /** The engine reports every freshly opened character as modified, so we track real edits ourselves. */
  unsaved: boolean
  markSaved(id: string): void
  /** For edits that do not go through mutate() (biography, notes...): the character now differs from its file. */
  markUnsaved(id: string): void
  toasts: Toast[]
  chooserRequest: ChooserRequest | null
  builderRequest: BuilderRequest | null
  confirmRequest: ConfirmRequest | null
  dismissToast(id: number): void
  notify(kind: Toast['kind'], text: string): void
  select(id: string): void
  openPath(path: string): Promise<void>
  /** Makes an empty character and returns its id (undefined if that failed). */
  createCharacter(): Promise<string | undefined>
  closeCharacter(id: string): Promise<void>
  /** Runs a change that returns the updated character, applies it, and surfaces engine messages. */
  mutate<T extends Changed>(fn: () => Promise<T>): Promise<T | null>
  /** Runs any engine call with busy/error handling; returns undefined on failure. */
  act<T>(fn: () => Promise<T>): Promise<T | undefined>
  refresh(): Promise<void>
}

const Ctx = createContext<Store | null>(null)

export function useStore(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore outside StoreProvider')
  return s
}

let toastSeq = 1

function messageKind(level: string): Toast['kind'] {
  if (level === 'error') return 'error'
  if (level === 'warning') return 'warn'
  return 'info'
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null)
  const [connection, setConnection] = useState<Store['connection']>('connecting')
  const [characters, setCharacters] = useState<CharacterSummary[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [character, setCharacter] = useState<Character | null>(null)
  const [busyCount, setBusyCount] = useState(0)
  const [toasts, setToasts] = useState<Toast[]>([])
  const [chooserRequest, setChooserRequest] = useState<ChooserRequest | null>(null)
  const [builderRequest, setBuilderRequest] = useState<BuilderRequest | null>(null)
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null)
  const [unsavedIds, setUnsavedIds] = useState<ReadonlySet<string>>(new Set())
  const activeRef = useRef<string | null>(null)
  const recoveredRef = useRef(false)
  activeRef.current = activeId

  // Closing the window or tab with unsaved work asks first.
  useEffect(() => {
    if (unsavedIds.size === 0) return
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [unsavedIds])

  const markUnsaved = useCallback((id: string) => setUnsavedIds((s) => new Set(s).add(id)), [])
  const markSaved = useCallback((id: string) => {
    setUnsavedIds((s) => {
      const n = new Set(s)
      n.delete(id)
      return n
    })
  }, [])

  const dismissToast = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const notify = useCallback(
    (kind: Toast['kind'], text: string) => {
      const id = toastSeq++
      setToasts((t) => [...t, { id, kind, text }])
      // Errors stay until dismissed; the rest fade on their own.
      if (kind !== 'error') window.setTimeout(() => dismissToast(id), 6000)
    },
    [dismissToast],
  )

  const showMessages = useCallback(
    (messages: EngineMessage[] | undefined) => {
      for (const m of messages ?? []) {
        if (m.level === 'chooser-declined' || m.title === 'level-up') continue
        notify(messageKind(m.level), m.text)
      }
    },
    [notify],
  )

  const loadCharacter = useCallback(async (id: string) => {
    const c = await api.get<Character>(`/characters/${encodeURIComponent(id)}`)
    setCharacter(c)
  }, [])

  const refresh = useCallback(async () => {
    try {
      let h = await api.get<Health>('/health')
      // A previous page (closed or reloaded mid-question) can leave the engine waiting for an answer
      // nobody will give. Cancel it so this page isn't locked out.
      if (!recoveredRef.current) {
        // Cancelling a question can make the engine ask the next one, so keep going until nothing is pending.
        for (let i = 0; i < 25 && (h.pendingBuilder || h.pendingChooser || h.pendingConfirm); i++) {
          // Questions first: a builder edit can be stuck on one, and cancelling the builder would wait behind it.
          if (h.pendingChooser) await api.request('POST', `/choosers/${h.pendingChooser}`, { cancel: true })
          else if (h.pendingConfirm) await api.request('POST', `/confirms/${h.pendingConfirm}`, { ok: false })
          else if (h.pendingBuilder) await api.request('POST', '/builder/cancel')
          h = await api.get<Health>('/health')
        }
      }
      recoveredRef.current = true
      setHealth(h)
      setConnection('ok')
      const list = await api.get<CharacterSummary[]>('/characters')
      setCharacters(list)
      const current = activeRef.current
      const next = current && list.some((c) => c.id === current) ? current : (list[0]?.id ?? null)
      setActiveId(next)
      if (next) await loadCharacter(next)
      else setCharacter(null)
    } catch (e) {
      setConnection('down')
      if (!(e instanceof ApiError && e.status === 0)) notify('error', e instanceof Error ? e.message : String(e))
    }
  }, [loadCharacter, notify])

  // Connect on start; keep retrying quietly while the engine is unreachable (it takes a few seconds to load).
  useEffect(() => {
    void refresh()
  }, [refresh])
  useEffect(() => {
    if (connection === 'ok') return
    const t = window.setInterval(() => void refresh(), 2500)
    return () => window.clearInterval(t)
  }, [connection, refresh])

  useEffect(() => {
    api.setInteractions({
      askChooser: (chooser) => new Promise((resolve) => setChooserRequest({ chooser, resolve })),
      askConfirm: (confirm) => new Promise((resolve) => setConfirmRequest({ confirm, resolve })),
      runBuilder: (builder) => new Promise((resolve) => setBuilderRequest({ builder, resolve })),
    })
    return () => api.setInteractions(null)
  }, [])

  const act = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      setBusyCount((n) => n + 1)
      try {
        return await fn()
      } catch (e) {
        notify('error', e instanceof Error ? e.message : String(e))
        if (e instanceof ApiError && e.status === 0) setConnection('down')
        return undefined
      } finally {
        setBusyCount((n) => n - 1)
      }
    },
    [notify],
  )

  const mutate = useCallback(
    async <T extends Changed>(fn: () => Promise<T>): Promise<T | null> => {
      const res = await act(fn)
      if (!res) return null
      if (res.character) {
        setCharacter(res.character)
        const cid = res.character.id
        setUnsavedIds((s) => new Set(s).add(cid))
      }
      showMessages(res.messages)
      return res
    },
    [act, showMessages],
  )

  const select = useCallback(
    (id: string) => {
      setActiveId(id)
      void act(() => loadCharacter(id))
    },
    [act, loadCharacter],
  )

  const openPath = useCallback(
    async (path: string) => {
      const res = await act(() => api.post<{ id: string; messages?: EngineMessage[] }>('/characters', { path }))
      if (!res) return
      showMessages(res.messages)
      const list = await act(() => api.get<CharacterSummary[]>('/characters'))
      if (list) setCharacters(list)
      setActiveId(res.id)
      await act(() => loadCharacter(res.id))
    },
    [act, loadCharacter, showMessages],
  )

  const createCharacter = useCallback(async () => {
    const res = await act(() => api.post<Changed>('/characters/new', {}))
    if (!res) return undefined
    const list = await act(() => api.get<CharacterSummary[]>('/characters'))
    if (list) setCharacters(list)
    setActiveId(res.character.id)
    setCharacter(res.character)
    return res.character.id
  }, [act])

  const closeCharacter = useCallback(
    async (id: string) => {
      const done = await act(() => api.del(`/characters/${encodeURIComponent(id)}`).then(() => true))
      if (done) markSaved(id) // a closed character has nothing left to lose
      await refresh()
    },
    [act, refresh, markSaved],
  )

  const value = useMemo<Store>(
    () => ({
      health,
      connection,
      characters,
      activeId,
      character,
      busy: busyCount > 0,
      unsaved: activeId !== null && unsavedIds.has(activeId),
      markSaved,
      markUnsaved,
      toasts,
      chooserRequest,
      builderRequest,
      confirmRequest,
      dismissToast,
      notify,
      select,
      openPath,
      createCharacter,
      closeCharacter,
      mutate,
      act,
      refresh,
    }),
    [health, connection, characters, activeId, character, busyCount, unsavedIds, markSaved, markUnsaved, toasts, chooserRequest, builderRequest, confirmRequest, dismissToast, notify, select, openPath, createCharacter, closeCharacter, mutate, act, refresh],
  )

  // The dialogs resolve through these; exposed via the value so components stay dumb.
  const resolveChooser = useCallback(
    (a: ChooserAnswer) => {
      chooserRequest?.resolve(a)
      setChooserRequest(null)
    },
    [chooserRequest],
  )
  const resolveConfirm = useCallback(
    (ok: boolean) => {
      confirmRequest?.resolve(ok)
      setConfirmRequest(null)
    },
    [confirmRequest],
  )
  const resolveBuilder = useCallback(
    (r: api.RawResponse) => {
      builderRequest?.resolve(r)
      setBuilderRequest(null)
    },
    [builderRequest],
  )

  return (
    <Ctx.Provider value={value}>
      <DialogBridge.Provider value={{ resolveChooser, resolveBuilder, resolveConfirm }}>{children}</DialogBridge.Provider>
    </Ctx.Provider>
  )
}

const DialogBridge = createContext<{
  resolveChooser(a: ChooserAnswer): void
  resolveBuilder(r: api.RawResponse): void
  resolveConfirm(ok: boolean): void
}>({ resolveChooser: () => {}, resolveBuilder: () => {}, resolveConfirm: () => {} })

export const useDialogBridge = () => useContext(DialogBridge)
