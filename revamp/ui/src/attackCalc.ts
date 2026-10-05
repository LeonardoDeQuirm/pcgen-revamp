/*
 * The attack calculator's rules. Pure functions, no screen and no engine: the figures that depend on the character (ability
 * scores, enchantment, Weapon Focus, ...) come from the engine, already worked out per weapon; this applies the combat
 * options on top (two-weapon fighting, Power Attack, Vital Strike...). Written so it can run under plain Node for tests
 * (type annotations only: no enums, no imports).
 */

/** One weapon as the engine prints it on the sheet. */
export interface WeaponFigures {
  index: number
  name: string
  melee: boolean
  ranged: boolean
  natural: boolean
  light: boolean
  twoHanded: boolean
  /** "19-20", "20" */
  critRange: string
  critMult: number | null
  /** To hit with each attack the character gets from base attack bonus, before any combat option. */
  baseHit: number[]
  /** The weapon's damage dice, "1d4". */
  dice: string | null
  /** Flat damage by how the weapon is held; null when the engine says the weapon cannot be used that way. */
  damageBonus: { oneHand: number | null; twoHand: number | null; offHand: number | null }
}

export type Action = 'full' | 'single' | 'charge' | 'vital'

/** Which of the supported feats the character has. */
export interface Owned {
  twoWeaponFighting: boolean
  improvedTwoWeaponFighting: boolean
  greaterTwoWeaponFighting: boolean
  doubleSlice: boolean
  twoWeaponRend: boolean
  powerAttack: boolean
  piranhaStrike: boolean
  deadlyAim: boolean
  rapidShot: boolean
  furiousFocus: boolean
  combatExpertise: boolean
  /** 0 = none, 2 = Vital Strike, 3 = Improved, 4 = Greater: how many times the weapon's dice are rolled. */
  vitalStrikeDice: number
}

/** What the player has switched on. */
export interface Choices {
  action: Action
  /** A one-handed weapon held in both hands. */
  twoHands: boolean
  powerAttack: number
  piranhaStrike: number
  deadlyAim: number
  combatExpertise: number
  rapidShot: boolean
  furiousFocus: boolean
  doubleSlice: boolean
  twoWeaponRend: boolean
  /** Vital Strike dice (2, 3 or 4), or 0 to not use it. Only with the Vital Strike action. */
  vitalStrikeDice: number
  haste: boolean
  flanking: boolean
  otherHit: number
  otherDamage: number
  /** d6 of sneak attack (or similar precision damage), added to every attack and never multiplied. */
  extraD6: number
  /** Armor class of the target, or null for "don't work out chances". */
  targetAc: number | null
}

export interface AttackRow {
  label: string
  hit: number
  /** "1d4" (or "2d4" with Vital Strike). */
  dice: string
  flat: number
  /** Written out: "1d4+10" and with sneak attack "1d4+10 +3d6". */
  damageText: string
  /** Average damage when the attack hits and is not a critical hit. */
  average: number
  /** How the to-hit and damage were put together, one short phrase per part. */
  hitParts: string[]
  damageParts: string[]
  /** With a target armor class: the chance to hit, and average damage including critical hits. */
  chance?: number
  expected?: number
}

export interface Result {
  rows: AttackRow[]
  /** Average damage if every attack hits, and what is expected against the target's armor class (if one was given). */
  totalIfAllHit: number
  totalExpected?: number
  critical: string
  notes: string[]
}

/** The most Power Attack, Piranha Strike, Deadly Aim or Combat Expertise steps a character may take. */
export function maxSteps(bab: number): number {
  return 1 + Math.floor(Math.max(bab, 0) / 4)
}

/** "1d4" -> { count: 1, sides: 4 }. */
export function parseDice(dice: string | null): { count: number; sides: number } | null {
  const m = /^(\d+)d(\d+)$/.exec((dice ?? '').trim())
  return m ? { count: Number(m[1]), sides: Number(m[2]) } : null
}

/** "19-20" -> 19, "20" -> 20. */
export function threatFrom(range: string): number {
  const m = /^(\d+)(?:\s*-\s*\d+)?$/.exec(range.trim())
  return m ? Math.min(Number(m[1]), 20) : 20
}

const signed = (n: number) => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`)

/** Chance that a d20 roll plus bonus meets the armor class: a natural 20 always hits and a 1 always misses. */
export function hitChance(bonus: number, ac: number): number {
  const needed = ac - bonus
  return Math.min(0.95, Math.max(0.05, (21 - needed) / 20))
}

/** Chance of a critical hit: the roll is in the threat range and hits, then a second roll confirms. */
export function critChance(bonus: number, ac: number, threatMin: number): number {
  let threats = 0
  for (let roll = threatMin; roll <= 20; roll++) if (roll === 20 || (roll > 1 && roll + bonus >= ac)) threats++
  return (threats / 20) * hitChance(bonus, ac)
}

const round1 = (n: number) => Math.round(n * 10) / 10

export function calculate(bab: number, strMod: number, main: WeaponFigures, off: WeaponFigures | null, owned: Owned, pick: Choices): Result {
  const notes: string[] = []
  const rows: AttackRow[] = []
  const dice = parseDice(main.dice)
  const full = pick.action === 'full'
  const steps = maxSteps(bab)
  const twoWeapon = full && !!off && main.melee && !main.twoHanded && !!off.baseHit.length
  const heldInTwo = !twoWeapon && (main.twoHanded || (pick.twoHands && !main.light))
  // Not every combination is allowed; say so instead of silently ignoring a choice.
  if (!main.baseHit.length) notes.push(`${main.name} cannot be used this way.`)
  if (!dice) notes.push(`Could not read the damage dice of ${main.name}.`)
  if (pick.action !== 'full' && off) notes.push('The off-hand weapon is only used in a full attack.')
  if (off && main.twoHanded) notes.push('A two-handed weapon leaves no hand for an off-hand weapon.')
  if (off && !main.melee) notes.push('Two-weapon fighting is for melee weapons.')

  const pa = main.melee && owned.powerAttack ? Math.min(pick.powerAttack, steps) : 0
  const ps = main.melee && owned.piranhaStrike && main.light ? Math.min(pick.piranhaStrike, steps) : 0
  const da = main.ranged && owned.deadlyAim ? Math.min(pick.deadlyAim, steps) : 0
  const ce = main.melee && owned.combatExpertise ? Math.min(pick.combatExpertise, steps) : 0
  const rapid = full && main.ranged && owned.rapidShot && pick.rapidShot
  if (pick.powerAttack > 0 && pick.piranhaStrike > 0) notes.push('Piranha Strike cannot be used together with Power Attack.')
  if (pick.piranhaStrike > 0 && owned.piranhaStrike && !main.light) notes.push('Piranha Strike works only with light weapons.')
  const piranhaOnly = pa > 0 ? 0 : ps
  const furious = pa > 0 && owned.furiousFocus && pick.furiousFocus && (main.twoHanded || heldInTwo)

  // To-hit penalties of fighting with two weapons: -6 / -10, 2 better with a light off-hand weapon, and the feat makes both -2 / -2 better
  // (primary hand reduced by 2, off hand by 6).
  let mainTwf = 0
  let offTwf = 0
  if (twoWeapon) {
    mainTwf = -6
    offTwf = -10
    if (off?.light) {
      mainTwf += 2
      offTwf += 2
    }
    if (owned.twoWeaponFighting) {
      mainTwf += 2
      offTwf += 6
    }
  }
  const vital = pick.action === 'vital' && owned.vitalStrikeDice > 0 ? Math.min(Math.max(pick.vitalStrikeDice, 2), owned.vitalStrikeDice) : 1
  if (pick.action === 'vital' && !owned.vitalStrikeDice) notes.push('The character does not have Vital Strike.')
  const rolled = (d: { count: number; sides: number } | null, times: number) => (d ? `${d.count * times}d${d.sides}` : '?')

  /** Everything added to or taken from to-hit for any attack, with the reasons. */
  const common = (): { sum: number; parts: string[] } => {
    const parts: string[] = []
    let sum = 0
    const add = (n: number, why: string) => {
      if (n === 0) return
      sum += n
      parts.push(`${why} ${signed(n)}`)
    }
    add(-rapid * 2, 'Rapid Shot')
    add(pick.haste ? 1 : 0, 'Haste')
    add(pick.flanking ? 2 : 0, 'Flanking')
    add(pick.action === 'charge' ? 2 : 0, 'Charge')
    add(-ce, 'Combat Expertise')
    add(pick.otherHit, 'Other')
    return { sum, parts }
  }
  const base = common()

  const row = (label: string, w: WeaponFigures, hand: 'main' | 'off', baseHit: number, hitParts: string[], hitExtra: number, first: boolean, notesFor?: string): AttackRow => {
    const d = parseDice(w.dice)
    const handBonus = hand === 'off' ? (owned.doubleSlice && pick.doubleSlice ? w.damageBonus.oneHand : w.damageBonus.offHand) : heldInTwo ? w.damageBonus.twoHand : w.damageBonus.oneHand
    const dmgParts: string[] = []
    let flat = handBonus ?? 0
    dmgParts.push(`${w.name} ${hand === 'off' ? 'in the off hand' : heldInTwo ? 'in two hands' : 'one-handed'} ${signed(flat)}`)
    let hit = baseHit + hitExtra
    const parts = [`Base ${signed(baseHit)}`, ...hitParts]
    const addPenalty = (n: number, why: string) => {
      if (!n) return
      hit -= n
      parts.push(`${why} ${signed(-n)}`)
    }
    const paSteps = pa
    if (paSteps > 0) {
      const skipFirst = furious && first && hand === 'main'
      if (skipFirst) parts.push('Power Attack penalty ignored (Furious Focus)')
      else addPenalty(paSteps, 'Power Attack')
      const bonus = hand === 'off' ? Math.floor(paSteps) : heldInTwo ? paSteps * 3 : paSteps * 2
      flat += bonus
      dmgParts.push(`Power Attack ${signed(bonus)}`)
    }
    if (piranhaOnly > 0) {
      addPenalty(piranhaOnly, 'Piranha Strike')
      const bonus = hand === 'off' ? piranhaOnly : piranhaOnly * 2
      flat += bonus
      dmgParts.push(`Piranha Strike ${signed(bonus)}`)
    }
    if (da > 0) {
      addPenalty(da, 'Deadly Aim')
      flat += da * 2
      dmgParts.push(`Deadly Aim ${signed(da * 2)}`)
    }
    if (pick.otherDamage) {
      flat += pick.otherDamage
      dmgParts.push(`Other ${signed(pick.otherDamage)}`)
    }
    const times = vital
    if (times > 1) dmgParts.push(`Vital Strike: dice rolled ${times} times`)
    const sneak = pick.extraD6 > 0 ? ` +${pick.extraD6}d6` : ''
    const average = (d ? (d.count * times * (d.sides + 1)) / 2 : 0) + flat + pick.extraD6 * 3.5
    const r: AttackRow = {
      label,
      hit,
      dice: rolled(d, times),
      flat,
      damageText: `${rolled(d, times)}${flat ? signed(flat) : ''}${sneak}`,
      average: round1(average),
      hitParts: parts,
      damageParts: dmgParts,
    }
    if (notesFor) r.damageParts.push(notesFor)
    if (pick.targetAc !== null) {
      const ac = pick.targetAc
      const chance = hitChance(hit, ac)
      // Critical hits multiply the weapon's dice once (Vital Strike's extra dice and precision dice are not multiplied) and the flat bonuses.
      const multiplied = (d ? (d.count * (d.sides + 1)) / 2 : 0) + flat
      const mult = w.critMult ?? 2
      const extraOnCrit = (mult - 1) * multiplied
      r.chance = chance
      r.expected = round1(chance * average + critChance(hit, ac, threatFrom(w.critRange)) * extraOnCrit)
    }
    return r
  }

  if (main.baseHit.length) {
    // Main hand: one attack for each of the character's, or just the first for a single attack, charge or Vital Strike.
    const attacks = full ? main.baseHit : main.baseHit.slice(0, 1)
    const extras: number[] = []
    if (full && pick.haste) extras.push(main.baseHit[0])
    if (rapid) extras.push(main.baseHit[0])
    const ordered = [...attacks.slice(0, 1), ...extras, ...attacks.slice(1)]
    ordered.forEach((b, i) => {
      const isExtra = i >= 1 && i <= extras.length
      const label = isExtra ? (rapid && i === extras.length ? 'Extra (Rapid Shot)' : 'Extra (Haste)') : `${twoWeapon ? 'Main hand' : 'Attack'} ${isExtra ? '' : `#${i - extras.length + 1}`}`.trim()
      const parts = [...base.parts]
      if (mainTwf) parts.push(`Two-weapon fighting ${signed(mainTwf)}`)
      rows.push(row(label, main, 'main', b, parts, base.sum + mainTwf, i === 0))
    })
  }
  if (twoWeapon && off && off.baseHit.length) {
    // The off hand: one attack, a second with Improved Two-Weapon Fighting (-5) and a third with Greater (-10).
    const offAttacks = [0]
    if (owned.improvedTwoWeaponFighting) offAttacks.push(-5)
    if (owned.greaterTwoWeaponFighting) offAttacks.push(-10)
    offAttacks.forEach((rel, i) => {
      const parts = [...base.parts]
      if (offTwf) parts.push(`Two-weapon fighting ${signed(offTwf)}`)
      if (rel) parts.push(`Extra off-hand attack ${signed(rel)}`)
      rows.push(row(`Off hand #${i + 1}`, off, 'off', off.baseHit[0], parts, base.sum + offTwf + rel, false))
    })
  }
  if (twoWeapon && owned.twoWeaponRend && pick.twoWeaponRend) {
    const flat = Math.floor(1.5 * strMod)
    const average = 5.5 + flat + pick.extraD6 * 0
    rows.push({
      label: 'Two-Weapon Rend (once a round, if both weapons hit)',
      hit: 0,
      dice: '1d10',
      flat,
      damageText: `1d10${flat ? signed(flat) : ''}`,
      average: round1(average),
      hitParts: [],
      damageParts: [`1.5 × Strength ${signed(flat)}`],
    })
  }

  const attackRows = rows.filter((r) => r.hitParts.length > 0)
  const crit = main.critMult ? `${main.critRange}/×${main.critMult}` : main.critRange
  const result: Result = {
    rows,
    totalIfAllHit: round1(rows.reduce((n, r) => n + r.average, 0)),
    critical: crit,
    notes,
  }
  if (pick.targetAc !== null) {
    const ac = pick.targetAc
    let total = attackRows.reduce((n, r) => n + (r.expected ?? 0), 0)
    const rend = rows.find((r) => r.hitParts.length === 0)
    if (rend) {
      // Both weapons must hit: use the first attack of each hand.
      const mainFirst = attackRows.find((r) => r.label.startsWith('Main hand #1'))
      const offFirst = attackRows.find((r) => r.label.startsWith('Off hand #1'))
      rend.expected = mainFirst && offFirst ? round1(hitChance(mainFirst.hit, ac) * hitChance(offFirst.hit, ac) * rend.average) : 0
      total += rend.expected
    }
    result.totalExpected = round1(total)
  }
  return result
}
