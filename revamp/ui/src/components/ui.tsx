import { useEffect, useRef, useState, type ReactNode } from 'react'

export function signed(n: number): string {
  return n >= 0 ? `+${n}` : `−${Math.abs(n)}`
}

export function useDebounced<T>(value: T, ms = 220): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return v
}

type IconName = 'chevron' | 'search' | 'folder' | 'file' | 'plus' | 'close' | 'up' | 'download' | 'hex' | 'check' | 'minus'

const paths: Record<IconName, ReactNode> = {
  chevron: <path d="M9 6l6 6-6 6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </>
  ),
  folder: <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />,
  file: (
    <>
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v4h4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  up: <path d="M12 19V5M6 11l6-6 6 6" />,
  download: <path d="M12 4v11M7 11l5 5 5-5M5 20h14" />,
  hex: <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />,
  check: <path d="M5 12l5 5 9-10" />,
}

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}

/** Open dialogs, oldest first. */
const openModals: { close?: () => void }[] = []

// One listener for all dialogs, so Escape reaches exactly one of them: the topmost, whether or not that one can be closed.
// (Separate listeners per dialog cannot do this: the one that closes first removes itself, and the next then thinks it is on top.)
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') openModals[openModals.length - 1]?.close?.()
  })
}

export function Modal({
  title,
  subtitle,
  children,
  footer,
  onClose,
  wide,
}: {
  title: string
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  onClose?: () => void
  wide?: boolean
}) {
  const entry = useRef<{ close?: () => void }>({})
  entry.current.close = onClose
  useEffect(() => {
    const mine = entry.current
    openModals.push(mine)
    return () => {
      const at = openModals.indexOf(mine)
      if (at >= 0) openModals.splice(at, 1)
    }
  }, [])
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  )
}

export function Card({ title, action, children }: { title?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {title ? (
        <div className="card-title">
          <span>{title}</span>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  )
}

/** The first letter(s) of a name, for avatars. */
export function initials(name: string | null | undefined): string {
  const n = (name ?? '').trim()
  return n ? n[0].toUpperCase() : '?'
}
