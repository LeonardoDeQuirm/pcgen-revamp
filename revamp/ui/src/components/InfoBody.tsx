import { useState } from 'react'

/** What the engine tells us about an ability or spell (see the .../info routes). */
export interface InfoLike {
  name: string
  description?: string | null
  /** What the character picked for a feat that asks (e.g. the weapon for Weapon Focus). */
  choices?: string | null
  /** Set when the character can't take it; says why in plain words. */
  reason?: string | null
  /** False when the character fails the requirements. */
  qualified?: boolean
  sections: { label: string; text: string }[]
}

// What to read first; everything else follows.
const FIRST = ['Description', 'Benefit', 'Special', 'Normal', 'Requirements', 'Prerequisites']

/** The engine writes stat checks as "var: PreStatScore_STR at least 13"; show them the way players say it. */
function tidy(label: string, text: string): string {
  if (label !== 'Requirements' && label !== 'Prerequisites') return text
  return text.replace(/var: PreStatScore_(\w+) at least (\d+)/g, '$1 $2').replace(/var: /g, '')
}

/** Rules plumbing that means little to a player: PCGen's internal type tags, "bypass" switches and rule flags. */
function isTechnical(s: { label: string; text: string }): boolean {
  return s.label === 'Type' || (s.label === 'Requirements' && /Bypass\w*Restriction|rule: [A-Z_]+/.test(s.text))
}

/**
 * The description of one entry. The reading text comes first; PCGen's internal bookkeeping (Type tags
 * and the like) sits in a fold-out at the bottom, closed unless there's a conflict to explain.
 */
export function InfoBody({ info }: { info: InfoLike }) {
  const conflict = !!info.reason
  const [techOpen, setTechOpen] = useState(false)
  const showTech = techOpen || conflict
  const order = (label: string) => {
    const f = FIRST.indexOf(label)
    return f >= 0 ? f : 100
  }
  const sections = info.sections.filter((s) => s.text)
  const visible = sections.filter((s) => !isTechnical(s) && s.label !== 'Source')
  // Short, labelled facts (a spell's school, range, duration...) read better as a compact grid than as paragraphs.
  const isFact = (s: { label: string; text: string }) => FIRST.indexOf(s.label) < 0 && s.text.length <= 48 && !s.text.includes('\n')
  const facts = visible.filter(isFact)
  const reading = visible.filter((s) => !isFact(s)).sort((a, b) => order(a.label) - order(b.label))
  const technical = sections.filter(isTechnical)
  const source = sections.find((s) => s.label === 'Source')

  return (
    <div>
      {conflict && (
        <div className="notice bad" role="alert">
          <b>Can&rsquo;t be added.</b> {info.reason}
        </div>
      )}
      {info.choices ? (
        <div className="detail-chosen">
          <span className="muted">Chosen</span> <b>{info.choices}</b>
        </div>
      ) : null}
      {facts.length > 0 && (
        <dl className="facts">
          {facts.map((f) => (
            <div key={f.label}>
              <dt>{f.label}</dt>
              <dd>{f.text}</dd>
            </div>
          ))}
        </dl>
      )}
      {reading.map((s) => (
        <section key={s.label} className="detail-section">
          <h3>{s.label}</h3>
          <p>{tidy(s.label, s.text)}</p>
        </section>
      ))}
      {reading.length === 0 && info.description && (
        <section className="detail-section">
          <h3>Description</h3>
          <p>{info.description}</p>
        </section>
      )}
      {reading.length === 0 && !info.description && <p className="muted">The rules data has no description for this entry.</p>}
      {(source || technical.length > 0) && (
        <div className="detail-meta">
          {source && (
            <div>
              <dt>Source</dt>
              <dd>{source.text}</dd>
            </div>
          )}
          {technical.length > 0 && (
            <div>
              <button className="disclosure" aria-expanded={showTech} onClick={() => setTechOpen((o) => !o)}>
                <span className="chev" data-open={showTech}>
                  &#9656;
                </span>{' '}
                Technical details
              </button>
              {showTech && (
                <dl className="tech">
                  {technical.map((s) => (
                    <div key={s.label}>
                      <dt>{s.label}</dt>
                      <dd>{tidy(s.label, s.text)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
