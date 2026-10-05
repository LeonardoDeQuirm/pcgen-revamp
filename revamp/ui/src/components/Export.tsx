import { useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api'
import { useStore } from '../store'
import type { Character, TemplateList } from '../types'
import { Card, Icon } from './ui'

/** Pretty label for "d20/fantasy/pdf/csheet_fantasy_std_blue.xslt" -> "Standard, blue". */
function label(template: string): string {
  const base = template.split('/').pop() ?? template
  return base
    .replace(/\.(xslt|xsl|fo)$/i, '')
    .replace(/^csheet_/, '')
    .replace(/_/g, ' ')
}

export function Export({ character }: { character: Character }) {
  const { act, notify } = useStore()
  const [templates, setTemplates] = useState<TemplateList | null>(null)
  const [choice, setChoice] = useState('')
  const [pdfUrl, setPdfUrl] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  // Which version of the character the shown sheet was made from (the object changes with every edit).
  const madeFrom = useRef<Character | null>(null)
  const outOfDate = !!pdfUrl && madeFrom.current !== character
  const id = encodeURIComponent(character.id)

  useEffect(() => {
    let live = true
    void act(() => api.get<TemplateList>(`/characters/${id}/templates`, { kind: 'pdf', limit: 500 })).then((t) => {
      if (!live || !t) return
      setTemplates(t)
      setChoice((c) => c || t.defaultPdf || t.items[0]?.template || '')
    })
    return () => {
      live = false
    }
  }, [id, act])

  // Release the old blob when a new one replaces it, and on leaving the tab.
  useEffect(() => () => void (pdfUrl && URL.revokeObjectURL(pdfUrl)), [pdfUrl])

  const groups = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const t of templates?.items ?? []) {
      const dir = t.template.split('/').slice(0, -2).join(' / ') || 'Sheets'
      m.set(dir, [...(m.get(dir) ?? []), t.template])
    }
    return m
  }, [templates])

  const generate = async () => {
    if (!choice) return
    setWorking(true)
    const snapshot = character
    const blob = await act(() => api.exportFile(character.id, { template: choice }))
    setWorking(false)
    if (blob) {
      madeFrom.current = snapshot
      setPdfUrl(URL.createObjectURL(blob))
    }
    else notify('error', 'The sheet could not be generated.')
  }

  const fileName = `${(character.name || character.id).replace(/[^\w.-]+/g, '_')}.pdf`

  return (
    <div className="grid" style={{ gap: 18 }}>
      <Card title="Character sheet (PDF)">
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <select className="select" style={{ flex: '1 1 320px', width: 'auto' }} value={choice} onChange={(e) => setChoice(e.target.value)} aria-label="Sheet design">
            {[...groups.entries()].map(([dir, items]) => (
              <optgroup key={dir} label={dir}>
                {items.map((t) => (
                  <option key={t} value={t}>{label(t)}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <button className="btn primary" disabled={!choice || working} onClick={() => void generate()}>
            {working ? <span className="spinner" style={{ width: 14, height: 14, borderWidth: 2 }} /> : null}
            {working ? 'Rendering…' : pdfUrl ? 'Refresh' : 'Generate'}
          </button>
          {outOfDate && !working && <span className="chip warn">Changed since this sheet was made</span>}
          {pdfUrl && (
            <a className="btn" href={pdfUrl} download={fileName}>
              <Icon name="download" /> Download
            </a>
          )}
        </div>
      </Card>
      {pdfUrl ? (
        <iframe className="preview" src={pdfUrl} title="Character sheet preview" />
      ) : (
        <div className="empty card">Choose a design and press Generate to preview the sheet.</div>
      )}
    </div>
  )
}
