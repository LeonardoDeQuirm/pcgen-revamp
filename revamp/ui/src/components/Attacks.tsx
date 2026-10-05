import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import * as api from '../api'
import { useStore } from '../store'
import type { Character } from '../types'
import { calculate, maxSteps, type Choices, type Owned, type WeaponFigures } from '../attackCalc'
import { Card, Empty, signed } from './ui'

interface ApiWeapon extends WeaponFigures {
  longName: string
  hand: string
  category: string
}
interface AttackData {
  bab: number
  weapons: ApiWeapon[]
  /** Which character these figures are for (the page may still hold the previous character's while the new ones load). */
  forId?: string
}

/** The feats the calculator knows about, by the name PCGen gives them. */
const FEATS: Record<keyof Omit<Owned, 'vitalStrikeDice'>, string> = {
  twoWeaponFighting: 'Two-Weapon Fighting',
  improvedTwoWeaponFighting: 'Improved Two-Weapon Fighting',
  greaterTwoWeaponFighting: 'Greater Two-Weapon Fighting',
  doubleSlice: 'Double Slice',
  twoWeaponRend: 'Two-Weapon Rend',
  powerAttack: 'Power Attack',
  piranhaStrike: 'Piranha Strike',
  deadlyAim: 'Deadly Aim',
  rapidShot: 'Rapid Shot',
  furiousFocus: 'Furious Focus',
  combatExpertise: 'Combat Expertise',
}

function ownedFeats(character: Character): Owned {
  const names = new Set<string>()
  for (const cat of character.abilityCategories) for (const a of cat.abilities) names.add(a.name.toLowerCase())
  const has = (n: string) => names.has(n.toLowerCase())
  const o = { vitalStrikeDice: has('Greater Vital Strike') ? 4 : has('Improved Vital Strike') ? 3 : has('Vital Strike') ? 2 : 0 } as Owned
  for (const [key, name] of Object.entries(FEATS)) (o as unknown as Record<string, boolean>)[key] = has(name)
  return o
}

const DEFAULTS: Choices = {
  action: 'full',
  twoHands: false,
  powerAttack: 0,
  piranhaStrike: 0,
  deadlyAim: 0,
  combatExpertise: 0,
  rapidShot: false,
  furiousFocus: false,
  doubleSlice: true,
  twoWeaponRend: true,
  vitalStrikeDice: 0,
  haste: false,
  flanking: false,
  otherHit: 0,
  otherDamage: 0,
  extraD6: 0,
  targetAc: null,
}

interface Saved {
  main: number | null
  off: number | null
  choices: Choices
}

const key = (id: string) => `pcgen.ui.attacks.${id}`
function load(id: string): Saved | null {
  try {
    return JSON.parse(window.localStorage.getItem(key(id)) ?? 'null') as Saved | null
  } catch {
    return null
  }
}

const label = (w: ApiWeapon) => {
  const name = w.name.replace(/^\*/, '')
  const where = /primary/i.test(w.hand) ? 'main hand' : /off/i.test(w.hand) ? 'off hand' : /both/i.test(w.hand) ? 'both hands' : /carried/i.test(w.hand) ? 'carried' : ''
  return where ? `${name} · ${where}` : name
}

function Stepper({ value, max, onChange, name }: { value: number; max: number; onChange: (n: number) => void; name: string }) {
  return (
    <span className="stepper">
      <button className="btn small icon" aria-label={`Less ${name}`} disabled={value <= 0} onClick={() => onChange(value - 1)}>
        &minus;
      </button>
      <b className="num">{value}</b>
      <button className="btn small icon" aria-label={`More ${name}`} disabled={value >= max} onClick={() => onChange(value + 1)}>
        +
      </button>
    </span>
  )
}

function NumberBox({ value, onChange, name, width = 70 }: { value: number | null; onChange: (n: number | null) => void; name: string; width?: number }) {
  return (
    <input
      className="input num"
      style={{ width }}
      inputMode="numeric"
      aria-label={name}
      value={value === null ? '' : String(value)}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => {
        const t = e.target.value.trim()
        if (t === '' || t === '-') return onChange(t === '' ? null : 0)
        const n = Number(t)
        if (Number.isFinite(n)) onChange(Math.round(n))
      }}
    />
  )
}

/** To hit and damage for a round of attacks with the weapons the character carries, with the combat feats it has. */
export function Attacks({ character }: { character: Character }) {
  const { act } = useStore()
  const [data, setData] = useState<AttackData | null>(null)
  const id = encodeURIComponent(character.id)
  const [main, setMain] = useState<number | null>(null)
  const [off, setOff] = useState<number | null>(null)
  const [pick, setPick] = useState<Choices>(DEFAULTS)
  const [open, setOpen] = useState<number | null>(null)
  // Choices are only remembered once the saved ones (or the defaults) have been put in place, never before.
  const ready = useRef<string | null>(null)

  useEffect(() => {
    let live = true
    void act(() => api.get<AttackData>(`/characters/${id}/attacks`)).then((d) => live && d && setData({ ...d, forId: character.id }))
    return () => {
      live = false
    }
  }, [id, character, act])

  // Pick the weapons the character is wielding the first time, and remember choices per character after that.
  useEffect(() => {
    if (!data || data.forId !== character.id) return
    const saved = load(character.id)
    const exists = (i: number | null | undefined): i is number => i !== null && i !== undefined && data.weapons.some((w) => w.index === i)
    // Natural attacks (a bite) come first in the engine's list but are rarely what the player means.
    // A shield is in the weapon list too (it can bash) but is not the second weapon of two-weapon fighting.
    const wielded = (hand: RegExp) => data.weapons.find((w) => w.melee && !w.natural && !/shield/i.test(w.name) && hand.test(w.hand))
    const defaultMain = (wielded(/primary|both/i) ?? data.weapons.find((w) => w.melee && !w.natural) ?? data.weapons.find((w) => w.melee) ?? data.weapons[0])?.index ?? null
    setMain(exists(saved?.main) ? saved.main : defaultMain)
    setOff(saved && exists(saved.main) ? (exists(saved.off) ? saved.off : null) : (wielded(/off/i)?.index ?? null))
    setPick(saved ? { ...DEFAULTS, ...saved.choices } : DEFAULTS)
    ready.current = character.id
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.forId, character.id])

  useEffect(() => {
    if (ready.current !== character.id) return
    try {
      window.localStorage.setItem(key(character.id), JSON.stringify({ main, off, choices: pick } satisfies Saved))
    } catch {
      /* ignore */
    }
  }, [character.id, main, off, pick])

  const owned = useMemo(() => ownedFeats(character), [character])
  const strMod = character.stats.find((s) => s.key === 'STR')?.modifier ?? 0
  const set = (patch: Partial<Choices>) => setPick((p) => ({ ...p, ...patch }))

  const weapons = data && data.forId === character.id ? data.weapons : []
  const mainW = weapons.find((w) => w.index === main) ?? null
  const offW = off !== null && mainW ? (weapons.find((w) => w.index === off) ?? null) : null
  const result = useMemo(() => (mainW ? calculate(data?.bab ?? 0, strMod, mainW, offW, owned, pick) : null), [data?.bab, strMod, mainW, offW, owned, pick])

  if (!data || data.forId !== character.id) return null
  if (weapons.length === 0) {
    return (
      <Empty title="No weapons yet">
        Buy a weapon on the Gear tab (and equip it) and its attacks will show up here.
      </Empty>
    )
  }
  const steps = maxSteps(data.bab)
  const ranged = !!mainW?.ranged
  const missing = Object.entries(FEATS)
    .filter(([k]) => !(owned as unknown as Record<string, boolean>)[k])
    .map(([, name]) => name)
  if (!owned.vitalStrikeDice) missing.push('Vital Strike')

  return (
    <div className="grid sheet" style={{ gap: 18 }}>
      <div className="grid" style={{ gap: 18 }}>
        <Card title="Attacks">
          {result && result.notes.length > 0 && (
            <div className="notice warn">
              {result.notes.map((n) => (
                <div key={n}>{n}</div>
              ))}
            </div>
          )}
          {result && (
            <table className="table" aria-label="Attacks">
              <thead>
                <tr>
                  <th>Attack</th>
                  <th className="r">To hit</th>
                  <th>Damage</th>
                  <th className="r">Average</th>
                  {pick.targetAc !== null && <th className="r">Hit chance</th>}
                  {pick.targetAc !== null && <th className="r">Expected</th>}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r, i) => (
                  <Fragment key={r.label}>
                    <tr className="clickable" style={{ cursor: 'pointer' }} onClick={() => setOpen(open === i ? null : i)} title="Click to see how this was worked out">
                      <td>{r.label}</td>
                      <td className="r num">
                        <b>{r.hitParts.length ? signed(r.hit) : '–'}</b>
                      </td>
                      <td className="num">{r.damageText}</td>
                      <td className="r num">{r.average}</td>
                      {pick.targetAc !== null && <td className="r num">{r.chance === undefined ? '' : `${Math.round(r.chance * 100)}%`}</td>}
                      {pick.targetAc !== null && <td className="r num">{r.expected ?? ''}</td>}
                    </tr>
                    {open === i && (
                      <tr>
                        <td colSpan={pick.targetAc !== null ? 6 : 4} className="muted" style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                          {r.hitParts.length > 0 && <div>To hit: {r.hitParts.join(' · ')}</div>}
                          <div>Damage: {r.damageParts.join(' · ')}</div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
          {result && (
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', paddingTop: 14 }}>
              <div>
                <div className="muted" style={{ fontSize: 12 }}>If every attack hits</div>
                <b className="num" style={{ fontSize: 20 }}>{result.totalIfAllHit}</b> <span className="muted">average damage</span>
              </div>
              {result.totalExpected !== undefined && (
                <div>
                  <div className="muted" style={{ fontSize: 12 }}>Expected against AC {pick.targetAc}</div>
                  <b className="num" style={{ fontSize: 20 }}>{result.totalExpected}</b> <span className="muted">average damage, with critical hits</span>
                </div>
              )}
              <div>
                <div className="muted" style={{ fontSize: 12 }}>Critical hit</div>
                <b className="num" style={{ fontSize: 20 }}>{result.critical}</b>
              </div>
            </div>
          )}
          <p className="muted" style={{ fontSize: 12, lineHeight: 1.5, paddingTop: 12 }}>
            The weapon figures (ability scores, enchantment, Weapon Focus and so on) come from the character sheet; the options on the right are added on top.
            Not covered: Manyshot, Flurry of Blows, Cleave, mounted combat and conditions beyond the ones listed.
          </p>
        </Card>
      </div>

      <div className="grid" style={{ gap: 18 }}>
        <Card title="Weapons">
          <label className="field">
            <span>Main hand</span>
            <select className="select" aria-label="Main hand weapon" value={main ?? ''} onChange={(e) => setMain(Number(e.target.value))}>
              {weapons.map((w) => (
                <option key={w.index} value={w.index}>
                  {label(w)}
                </option>
              ))}
            </select>
          </label>
          <label className="field" style={{ paddingTop: 10 }}>
            <span>Off hand</span>
            <select className="select" aria-label="Off hand weapon" value={off ?? ''} onChange={(e) => setOff(e.target.value === '' ? null : Number(e.target.value))}>
              <option value="">None</option>
              {weapons
                .filter((w) => w.index !== main && w.melee)
                .map((w) => (
                  <option key={w.index} value={w.index}>
                    {label(w)}
                  </option>
                ))}
            </select>
          </label>
          <label className="field" style={{ paddingTop: 10 }}>
            <span>Action</span>
            <select className="select" aria-label="Action" value={pick.action} onChange={(e) => set({ action: e.target.value as Choices['action'] })}>
              <option value="full">Full attack</option>
              <option value="single">Single attack (standard action)</option>
              <option value="charge">Charge (one attack, +2)</option>
              {owned.vitalStrikeDice > 0 && <option value="vital">Vital Strike</option>}
            </select>
          </label>
          {mainW && mainW.melee && !mainW.twoHanded && !mainW.light && !offW && (
            <label className="check-row">
              <input type="checkbox" checked={pick.twoHands} onChange={(e) => set({ twoHands: e.target.checked })} />
              Hold it in both hands
            </label>
          )}
          {pick.action === 'vital' && owned.vitalStrikeDice > 0 && (
            <label className="field" style={{ paddingTop: 10 }}>
              <span>Vital Strike</span>
              <select className="select" aria-label="Vital Strike dice" value={Math.max(pick.vitalStrikeDice, 2)} onChange={(e) => set({ vitalStrikeDice: Number(e.target.value) })}>
                <option value={2}>Vital Strike: weapon dice ×2</option>
                {owned.vitalStrikeDice >= 3 && <option value={3}>Improved: ×3</option>}
                {owned.vitalStrikeDice >= 4 && <option value={4}>Greater: ×4</option>}
              </select>
            </label>
          )}
        </Card>

        <Card title="Feats">
          <div className="grid" style={{ gap: 10 }}>
            {owned.powerAttack && !ranged && (
              <Row name="Power Attack" hint={`−1 to hit, +2 damage a step (+3 in two hands, +1 off hand). Up to ${steps}.`}>
                <Stepper value={pick.powerAttack} max={steps} onChange={(n) => set({ powerAttack: n, piranhaStrike: n > 0 ? 0 : pick.piranhaStrike })} name="Power Attack" />
              </Row>
            )}
            {owned.furiousFocus && owned.powerAttack && !ranged && (
              <label className="check-row" title="Two-handed: no Power Attack penalty on the first attack each turn">
                <input type="checkbox" checked={pick.furiousFocus} onChange={(e) => set({ furiousFocus: e.target.checked })} />
                Furious Focus
              </label>
            )}
            {owned.piranhaStrike && !ranged && (
              <Row name="Piranha Strike" hint={`Light weapons: −1 to hit, +2 damage a step (half off hand). Not with Power Attack. Up to ${steps}.`}>
                <Stepper value={pick.piranhaStrike} max={steps} onChange={(n) => set({ piranhaStrike: n, powerAttack: n > 0 ? 0 : pick.powerAttack })} name="Piranha Strike" />
              </Row>
            )}
            {owned.deadlyAim && ranged && (
              <Row name="Deadly Aim" hint={`Ranged: −1 to hit, +2 damage a step. Up to ${steps}.`}>
                <Stepper value={pick.deadlyAim} max={steps} onChange={(n) => set({ deadlyAim: n })} name="Deadly Aim" />
              </Row>
            )}
            {owned.rapidShot && ranged && (
              <label className="check-row" title="An extra ranged attack in a full attack, every attack at −2">
                <input type="checkbox" checked={pick.rapidShot} onChange={(e) => set({ rapidShot: e.target.checked })} />
                Rapid Shot (extra attack, −2 to all)
              </label>
            )}
            {owned.combatExpertise && !ranged && (
              <Row name="Combat Expertise" hint={`−1 to hit for +1 dodge to AC a step. Up to ${steps}.`}>
                <Stepper value={pick.combatExpertise} max={steps} onChange={(n) => set({ combatExpertise: n })} name="Combat Expertise" />
              </Row>
            )}
            {owned.doubleSlice && offW && (
              <label className="check-row" title="Off-hand damage gets your full Strength bonus">
                <input type="checkbox" checked={pick.doubleSlice} onChange={(e) => set({ doubleSlice: e.target.checked })} />
                Double Slice (full Strength on the off hand)
              </label>
            )}
            {owned.twoWeaponRend && offW && (
              <label className="check-row" title="Extra 1d10 plus 1½ × Strength if both weapons hit">
                <input type="checkbox" checked={pick.twoWeaponRend} onChange={(e) => set({ twoWeaponRend: e.target.checked })} />
                Two-Weapon Rend (if both hit)
              </label>
            )}
            {offW && (
              <div className="muted" style={{ fontSize: 12.5 }}>
                Two-weapon fighting: {[owned.twoWeaponFighting && 'Two-Weapon Fighting', owned.improvedTwoWeaponFighting && 'Improved (extra off-hand attack at −5)', owned.greaterTwoWeaponFighting && 'Greater (and at −10)'].filter(Boolean).join(', ') || 'no feats, full penalties'}
              </div>
            )}
            {missing.length > 0 && (
              <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>Not on this character: {missing.join(', ')}.</div>
            )}
          </div>
        </Card>

        <Card title="Situation">
          <label className="check-row">
            <input type="checkbox" checked={pick.haste} onChange={(e) => set({ haste: e.target.checked })} />
            Hasted (extra attack, +1 to hit)
          </label>
          <label className="check-row">
            <input type="checkbox" checked={pick.flanking} onChange={(e) => set({ flanking: e.target.checked })} />
            Flanking (+2 to hit)
          </label>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 12px', alignItems: 'center', paddingTop: 12 }}>
            <span className="muted">Sneak attack dice (d6)</span>
            <NumberBox name="Sneak attack dice" value={pick.extraD6} onChange={(n) => set({ extraD6: Math.max(0, n ?? 0) })} />
            <span className="muted">Other to hit</span>
            <NumberBox name="Other to hit" value={pick.otherHit} onChange={(n) => set({ otherHit: n ?? 0 })} />
            <span className="muted">Other damage</span>
            <NumberBox name="Other damage" value={pick.otherDamage} onChange={(n) => set({ otherDamage: n ?? 0 })} />
            <span className="muted">Target armor class</span>
            <NumberBox name="Target armor class" value={pick.targetAc} onChange={(n) => set({ targetAc: n })} />
          </div>
          <p className="muted" style={{ fontSize: 12, lineHeight: 1.5, paddingTop: 8 }}>
            Sneak attack dice are added to every attack and never multiplied on a critical hit. Leave the armor class empty for no hit chances.
          </p>
        </Card>
      </div>
    </div>
  )
}

function Row({ name, hint, children }: { name: string; hint: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }} title={hint}>
      <div>
        <div>{name}</div>
        <div className="muted" style={{ fontSize: 12, lineHeight: 1.4, maxWidth: 260 }}>{hint}</div>
      </div>
      {children}
    </div>
  )
}
