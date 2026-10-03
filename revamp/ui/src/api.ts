import type { BuilderState, ChooserAnswer, PendingChooser, PendingConfirm } from './types'

/** An error reply from the sidecar (4xx/5xx) or a failure to reach it. */
export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export interface RawResponse {
  status: number
  data: any
  blob?: Blob
}

const BASE = '/api'

function url(path: string, query?: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') q.set(k, String(v))
  const s = q.toString()
  return BASE + path + (s ? '?' + s : '')
}

/** Low-level call. Resolves for every HTTP status; rejects only when the sidecar is unreachable. */
export async function request(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | number | boolean | undefined>,
): Promise<RawResponse> {
  let res: Response
  try {
    res = await fetch(url(path, query), {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, 'Cannot reach the PCGen engine. Is the sidecar running?')
  }
  const type = res.headers.get('Content-Type') ?? ''
  if (type.startsWith('application/json')) return { status: res.status, data: await res.json() }
  if (type.startsWith('application/pdf')) return { status: res.status, data: null, blob: await res.blob() }
  return { status: res.status, data: await res.text() }
}

function failure(res: RawResponse): ApiError {
  const msg = res.data && typeof res.data === 'object' && 'error' in res.data ? String(res.data.error) : `Request failed (${res.status})`
  return new ApiError(res.status, msg)
}

/** A simple read. Throws ApiError on any non-2xx. */
export async function get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
  const res = await request('GET', path, undefined, query)
  if (res.status >= 400) throw failure(res)
  return res.data as T
}

/**
 * Hooks the UI provides so that engine questions can interrupt an operation: the engine may stop in
 * the middle of a change (202) to ask the user to pick something.
 */
export interface Interactions {
  askChooser(chooser: PendingChooser): Promise<ChooserAnswer>
  /** A yes/no question from the engine ("Are your abilities set as you'd like them?"). */
  askConfirm(confirm: PendingConfirm): Promise<boolean>
  /**
   * Called with the custom-equipment builder when a purchase asks to customise. The dialog edits the item through
   * /builder and finishes with commit or cancel; resolve with that finishing response (it carries the purchase's outcome).
   */
  runBuilder(builder: BuilderState): Promise<RawResponse>
}

let interactions: Interactions | null = null
export function setInteractions(i: Interactions | null): void {
  interactions = i
}

/**
 * A change that may pause for questions. Resolves with the final reply; throws ApiError on failure.
 * Cancelled questions are sent to the engine as a cancel, which it treats as "no change".
 */
export async function change<T>(
  method: string,
  path: string,
  body?: unknown,
  query?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  let res = await request(method, path, body, query)
  while (res.status === 202) {
    if (res.data?.pendingChooser) {
      const chooser = res.data.pendingChooser as PendingChooser
      const answer = interactions ? await interactions.askChooser(chooser) : { cancel: true }
      res = await request('POST', `/choosers/${chooser.id}`, answer)
    } else if (res.data?.pendingConfirm) {
      const confirm = res.data.pendingConfirm as PendingConfirm
      const ok = interactions ? await interactions.askConfirm(confirm) : false
      res = await request('POST', `/confirms/${confirm.id}`, { ok })
    } else if (res.data?.pendingBuilder) {
      const builder = res.data.pendingBuilder as BuilderState
      res = interactions ? await interactions.runBuilder(builder) : await request('POST', '/builder/cancel')
    } else {
      break
    }
  }
  if (res.status >= 400) throw failure(res)
  return res.data as T
}

export const post = <T>(path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>) =>
  change<T>('POST', path, body ?? {}, query)
export const patch = <T>(path: string, body: unknown) => change<T>('PATCH', path, body)
export const put = <T>(path: string, body: unknown) => change<T>('PUT', path, body)
export const del = <T>(path: string, query?: Record<string, string | number | boolean | undefined>) =>
  change<T>('DELETE', path, undefined, query)

/** Fetches a PDF (or other file) as a Blob. */
export async function exportFile(characterId: string, body: { template?: string; format?: string }): Promise<Blob> {
  const res = await request('POST', `/characters/${encodeURIComponent(characterId)}/export`, body)
  if (res.status >= 400) throw failure(res)
  if (res.blob) return res.blob
  return new Blob([typeof res.data === 'string' ? res.data : JSON.stringify(res.data)], { type: 'text/plain' })
}
