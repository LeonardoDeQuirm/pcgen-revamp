// Runs under plain Node: `npm run test:calc`. Figures are Kaito's (a rogue with two daggers) as the engine prints them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { calculate, maxSteps, hitChance, critChance, threatFrom, parseDice } from '../src/attackCalc.ts'

const dagger = (name, baseHit, one, off) => ({
  index: 1, name, melee: true, ranged: false, natural: false, light: true, twoHanded: false,
  critRange: '19-20', critMult: 2, baseHit, dice: '1d4', damageBonus: { oneHand: one, twoHand: one, offHand: off },
})
const mainHand = dagger('+2 Dagger', [21, 16], 10, 6)
const offHand = dagger('+1 Dagger', [20, 15], 9, 5)
const greatsword = {
  index: 2, name: 'Greatsword', melee: true, ranged: false, natural: false, light: false, twoHanded: true,
  critRange: '19-20', critMult: 2, baseHit: [15, 10, 5], dice: '2d6', damageBonus: { oneHand: null, twoHand: 7, offHand: null },
}
const longbow = {
  index: 3, name: 'Longbow', melee: false, ranged: true, natural: false, light: false, twoHanded: false,
  critRange: '20', critMult: 3, baseHit: [12, 7, 2], dice: '1d8', damageBonus: { oneHand: 2, twoHand: 2, offHand: null },
}
const none = {
  twoWeaponFighting: false, improvedTwoWeaponFighting: false, greaterTwoWeaponFighting: false, doubleSlice: false, twoWeaponRend: false,
  powerAttack: false, piranhaStrike: false, deadlyAim: false, rapidShot: false, furiousFocus: false, combatExpertise: false, vitalStrikeDice: 0,
}
const plain = {
  action: 'full', twoHands: false, powerAttack: 0, piranhaStrike: 0, deadlyAim: 0, combatExpertise: 0, rapidShot: false, furiousFocus: false,
  doubleSlice: false, twoWeaponRend: false, vitalStrikeDice: 0, haste: false, flanking: false, otherHit: 0, otherDamage: 0, extraD6: 0, targetAc: null,
}
const hits = (r) => r.rows.map((x) => x.hit)

test('a single weapon attacks once per base attack, with the engine figures', () => {
  const r = calculate(10, 0, mainHand, null, none, plain)
  assert.deepEqual(hits(r), [21, 16])
  assert.equal(r.rows[0].damageText, '1d4+10')
})

test('two weapons, light off hand, with Two-Weapon Fighting: -2 and -2, as the sheet prints (+19/+14 and +18/+13)', () => {
  const owned = { ...none, twoWeaponFighting: true, improvedTwoWeaponFighting: true }
  const r = calculate(10, 0, mainHand, offHand, owned, plain)
  assert.deepEqual(hits(r), [19, 14, 18, 13])
  assert.equal(r.rows[2].damageText, '1d4+5') // off-hand figure
})

test('two weapons without the feat: -6 / -10, light off hand -4 / -8', () => {
  const r = calculate(10, 0, mainHand, offHand, none, plain)
  assert.deepEqual(hits(r), [17, 12, 12])
  const heavy = calculate(10, 0, mainHand, { ...offHand, light: false }, none, plain)
  assert.deepEqual(hits(heavy), [15, 10, 10])
})

test('Greater Two-Weapon Fighting adds a third off-hand attack at -10', () => {
  const owned = { ...none, twoWeaponFighting: true, improvedTwoWeaponFighting: true, greaterTwoWeaponFighting: true }
  const r = calculate(10, 0, mainHand, offHand, owned, plain)
  assert.deepEqual(hits(r), [19, 14, 18, 13, 8])
})

test('Double Slice gives the off hand its full damage bonus', () => {
  const owned = { ...none, twoWeaponFighting: true, doubleSlice: true }
  const r = calculate(10, 0, mainHand, offHand, owned, { ...plain, doubleSlice: true })
  assert.equal(r.rows.find((x) => x.label.startsWith('Off hand')).flat, 9)
})

test('Two-Weapon Rend adds 1d10 plus one and a half times Strength once', () => {
  const owned = { ...none, twoWeaponFighting: true, twoWeaponRend: true }
  const r = calculate(10, 4, mainHand, offHand, owned, { ...plain, twoWeaponRend: true })
  const rend = r.rows[r.rows.length - 1]
  assert.equal(rend.damageText, '1d10+6')
})

test('Power Attack: 1 + BAB/4 steps, -1 each, +2 damage each', () => {
  assert.equal(maxSteps(10), 3)
  assert.equal(maxSteps(3), 1)
  assert.equal(maxSteps(16), 5)
  const owned = { ...none, powerAttack: true }
  const r = calculate(10, 0, mainHand, null, owned, { ...plain, powerAttack: 3 })
  assert.deepEqual(hits(r), [18, 13])
  assert.equal(r.rows[0].flat, 16)
})

test('Power Attack asks for no more than the character may take', () => {
  const owned = { ...none, powerAttack: true }
  const r = calculate(10, 0, mainHand, null, owned, { ...plain, powerAttack: 9 })
  assert.deepEqual(hits(r), [18, 13])
})

test('Power Attack: +3 per step in two hands, and half in the off hand', () => {
  const owned = { ...none, powerAttack: true }
  const two = calculate(8, 0, greatsword, null, owned, { ...plain, powerAttack: 2 })
  assert.equal(two.rows[0].flat, 7 + 6)
  const withOff = calculate(10, 0, mainHand, offHand, { ...owned, twoWeaponFighting: true }, { ...plain, powerAttack: 3 })
  const off = withOff.rows.find((x) => x.label.startsWith('Off hand'))
  assert.equal(off.flat, 5 + 3)
})

test('Furious Focus ignores the Power Attack penalty on the first attack with a two-handed weapon', () => {
  const owned = { ...none, powerAttack: true, furiousFocus: true }
  const r = calculate(8, 0, greatsword, null, owned, { ...plain, powerAttack: 2, furiousFocus: true })
  assert.deepEqual(hits(r), [15, 8, 3])
})

test('Piranha Strike: light weapons only, +2 damage per step, half in the off hand, never with Power Attack', () => {
  const owned = { ...none, piranhaStrike: true, powerAttack: true, twoWeaponFighting: true }
  const r = calculate(10, 0, mainHand, null, owned, { ...plain, piranhaStrike: 3 })
  assert.deepEqual(hits(r), [18, 13])
  assert.equal(r.rows[0].flat, 16)
  const off = calculate(10, 0, mainHand, offHand, owned, { ...plain, piranhaStrike: 3 }).rows.find((x) => x.label.startsWith('Off hand'))
  assert.equal(off.flat, 5 + 3)
  const heavy = calculate(8, 0, { ...mainHand, light: false }, null, owned, { ...plain, piranhaStrike: 2 })
  assert.deepEqual(hits(heavy), [21, 16])
  assert.ok(heavy.notes.some((n) => /light/.test(n)))
  const both = calculate(10, 0, mainHand, null, owned, { ...plain, piranhaStrike: 2, powerAttack: 2 })
  assert.ok(both.notes.some((n) => /together/.test(n)))
  assert.deepEqual(hits(both), [19, 14]) // Power Attack wins, Piranha Strike is dropped
})

test('Vital Strike: one attack at the highest bonus, weapon dice rolled again', () => {
  const owned = { ...none, vitalStrikeDice: 3 }
  const r = calculate(10, 0, greatsword, null, owned, { ...plain, action: 'vital', vitalStrikeDice: 3 })
  assert.equal(r.rows.length, 1)
  assert.equal(r.rows[0].damageText, '6d6+7')
  assert.equal(r.rows[0].hit, 15)
  const greater = calculate(10, 0, greatsword, null, { ...none, vitalStrikeDice: 4 }, { ...plain, action: 'vital', vitalStrikeDice: 4 })
  assert.equal(greater.rows[0].damageText, '8d6+7')
  const tooMuch = calculate(10, 0, greatsword, null, { ...none, vitalStrikeDice: 2 }, { ...plain, action: 'vital', vitalStrikeDice: 4 })
  assert.equal(tooMuch.rows[0].damageText, '4d6+7')
})

test('Vital Strike without the feat is flagged', () => {
  const r = calculate(10, 0, greatsword, null, none, { ...plain, action: 'vital', vitalStrikeDice: 2 })
  assert.ok(r.notes.some((n) => /Vital Strike/.test(n)))
})

test('single attack and charge: one attack, charge +2', () => {
  assert.deepEqual(hits(calculate(10, 0, mainHand, null, none, { ...plain, action: 'single' })), [21])
  assert.deepEqual(hits(calculate(10, 0, mainHand, null, none, { ...plain, action: 'charge' })), [23])
})

test('Haste: an extra attack at the highest bonus and +1 to hit', () => {
  assert.deepEqual(hits(calculate(10, 0, mainHand, null, none, { ...plain, haste: true })), [22, 22, 17])
})

test('Rapid Shot: an extra ranged attack, everything -2', () => {
  const owned = { ...none, rapidShot: true }
  assert.deepEqual(hits(calculate(10, 0, longbow, null, owned, { ...plain, rapidShot: true })), [10, 10, 5, 0])
})

test('Deadly Aim is the ranged Power Attack', () => {
  const owned = { ...none, deadlyAim: true }
  const r = calculate(10, 0, longbow, null, owned, { ...plain, deadlyAim: 3 })
  assert.deepEqual(hits(r), [9, 4, -1])
  assert.equal(r.rows[0].flat, 2 + 6)
})

test('choices for feats the character lacks are ignored', () => {
  const r = calculate(10, 0, mainHand, null, none, { ...plain, powerAttack: 3, piranhaStrike: 3, deadlyAim: 3 })
  assert.deepEqual(hits(r), [21, 16])
})

test('sneak attack dice and other bonuses are added to every attack', () => {
  const r = calculate(10, 0, mainHand, null, none, { ...plain, extraD6: 3, otherDamage: 1, otherHit: 1, flanking: true })
  assert.equal(r.rows[0].damageText, '1d4+11 +3d6')
  assert.deepEqual(hits(r), [24, 19])
  assert.equal(r.rows[0].average, 2.5 + 11 + 10.5)
})

test('hit chances: natural 20 always hits, 1 always misses', () => {
  assert.equal(hitChance(10, 15), 0.8)
  assert.equal(hitChance(30, 15), 0.95)
  assert.equal(hitChance(-5, 25), 0.05)
  assert.equal(threatFrom('19-20'), 19)
  assert.equal(threatFrom('20'), 20)
  assert.ok(critChance(10, 15, 19) > critChance(10, 15, 20))
  assert.deepEqual(parseDice('2d6'), { count: 2, sides: 6 })
  assert.equal(parseDice('N/A'), null)
})

test('against an armor class: expected damage includes critical hits', () => {
  const r = calculate(10, 0, mainHand, null, none, { ...plain, action: 'single', targetAc: 31 })
  const row = r.rows[0]
  assert.equal(row.chance, 0.55) // needs a 10 on the die
  assert.ok(row.expected > row.chance * row.average)
  assert.equal(r.totalExpected, row.expected)
})
