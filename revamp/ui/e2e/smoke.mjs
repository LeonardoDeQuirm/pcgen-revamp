// End-to-end smoke test: drives the real UI in a real browser against a running sidecar.
//
//   1. start the sidecar on a COPY of a character (never the original), e.g. the Cleric or .run/clarent.pcg
//   2. start the UI:        npm run dev        (http://127.0.0.1:5173)
//   3. run this:            npm run e2e -- <path-to-the-same-copy.pcg>
//
// It levels the character up (answering the engine's question in a dialog), removes the level again,
// checks the skills table, opens the item customiser and cancels it, and renders the PDF sheet.
// It leaves the character as it found it (nothing is saved).
import puppeteer from 'puppeteer-core'
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const URL = process.env.UI_URL ?? 'http://127.0.0.1:5173/'
const EDGE = process.env.BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const charPath = process.argv[2]
if (!charPath) {
  console.error('usage: node e2e/smoke.mjs <path-to-character-copy.pcg>')
  process.exit(2)
}
mkdirSync('../.run/shots', { recursive: true })

const results = []
const check = (name, ok, detail = '') => {
  results.push([name, !!ok, detail])
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ' - ' + detail}`)
}

const browser = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox'] })
const page = await browser.newPage()
await page.setViewport({ width: 1440, height: 1000 })
page.on('dialog', (d) => d.accept()) // window.confirm
page.on('pageerror', (e) => check('no uncaught page errors', false, String(e)))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const text = () => page.evaluate(() => document.body.innerText)
const waitText = (t, timeout = 20000) =>
  page.waitForFunction((s) => document.body.innerText.includes(s), { timeout }, t)
const clickText = async (sel, label) => {
  const ok = await page.evaluate(
    (sel, label) => {
      const el = [...document.querySelectorAll(sel)].find((e) => e.innerText.trim().startsWith(label) && !e.disabled)
      if (el) el.click()
      return !!el
    },
    sel,
    label,
  )
  if (!ok) throw new Error(`no enabled ${sel} starting with "${label}"`)
}
// Race and class pickers show a reading pane: select the entry, wait for its text, then confirm with "Choose ...".
const pickFrom = async (label) => {
  const title = await page.evaluate((l) => {
    const el = [...document.querySelectorAll('.modal .pick')].find((e) => e.innerText.trim().startsWith(l))
    if (!el) return null
    el.click()
    return el.querySelector('.row-title')?.innerText.trim() ?? l
  }, label)
  if (!title) throw new Error(`no choice starting with "${label}"`)
  await page.waitForFunction((t) => [...document.querySelectorAll('.modal button')].some((b) => b.innerText.trim() === 'Choose ' + t && !b.disabled), { timeout: 20000 }, title)
  await clickText('.modal button', 'Choose ' + title)
}
const shot = (name) => page.screenshot({ path: `../.run/shots/e2e-${name}.png` })

try {
  // Open the character through the same API the dialog uses, then load the UI.
  // (start-dev.ps1 already opened it; a second open just answers "already open", which is fine.)
  await fetch('http://127.0.0.1:8765/characters', { method: 'POST', body: JSON.stringify({ path: charPath }) })
  const id = charPath.split(/[\\/]/).pop().replace(/\.[^.]*$/, '')
  const snapshot = await (await fetch(`http://127.0.0.1:8765/characters/${id}`)).json()
  const levels = snapshot.levels.length
  await page.goto(URL + '#Overview', { waitUntil: 'networkidle0' })
  await waitText('Engine ready')
  check('shows the engine as ready', true)
  await waitText(snapshot.name)
  check('shows the character name and class line', (await text()).includes(snapshot.name))
  check('shows six ability tiles', (await page.$$('.ability')).length === 6)

  // Level up -> class picker -> engine asks for an ability score -> confirm
  await clickText('button', 'Level up')
  await page.waitForSelector('.modal .pick')
  await page.type('.modal input', 'Fighter')
  await sleep(500)
  await pickFrom('Fighter')
  // Some level-ups (every 4th) make the engine ask which ability score to raise; others finish straight away.
  const settled = await Promise.race([
    page.waitForSelector('.modal .choice', { timeout: 30000 }).then(() => 'question'),
    page.waitForFunction((n) => document.querySelectorAll('.level-row').length === n, { timeout: 30000 }, levels + 1).then(() => 'done'),
  ])
  if (settled === 'question') {
    check('engine question appears as a dialog', (await text()).includes('ability score'))
    await shot('chooser')
    await page.click('.modal .choice')
    await clickText('.modal button', 'Confirm')
  }
  await page.waitForFunction((n) => document.querySelectorAll('.level-row').length === n, { timeout: 30000 }, levels + 1)
  check(`level count went up by one${settled === 'question' ? ' (after answering the engine)' : ''}`, true)
  // A new level asks for the hit die result; type our own roll
  await page.waitForFunction(() => /Hit points for level/.test(document.querySelector('.modal')?.innerText ?? ''), { timeout: 20000 })
  check('a new level asks for the hit points roll', true)
  await shot('hp')
  const hpInfo = await page.$eval('.modal', (e) => e.innerText)
  check('the hit point dialog shows the die and the Constitution bonus', /d10|d8|d6|d12/.test(hpInfo) && /Constitution/i.test(hpInfo), hpInfo.slice(0, 160))
  await page.click('.modal input.input')
  await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control')
  await page.keyboard.type('4')
  await clickText('.modal button', 'Save')
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 20000 })
  const lastRow = await page.$$eval('.level-row', (r) => r[r.length - 1].innerText)
  check('the typed roll plus Constitution is what the level shows (4 + 2 = 6 HP)', /6 HP/.test(lastRow), lastRow)
  await clickText('button', 'Remove last')
  await page.waitForFunction((n) => document.querySelectorAll('.level-row').length === n, { timeout: 30000 }, levels)
  check('removing the level restores the count', true)

  // Skills: ranks must not exceed the character's level
  await clickText('button[role=tab]', 'Skills')
  await page.waitForSelector('.table tbody tr')
  const maxRank = await page.evaluate(() => Math.max(...[...document.querySelectorAll('.table tbody tr')].map((r) => Number(r.querySelector('.stepper b')?.textContent ?? 0))))
  check('skill ranks do not exceed level', maxRank <= levels, `max rank ${maxRank} vs level ${levels}`)
  await shot('skills')

  // Feats: sections fold, and an entry opens a side panel with what it does
  await clickText('button[role=tab]', 'Feats')
  await page.waitForSelector('.row.clickable')
  const firstToggle = '.card.collapsible .card-toggle'
  const rowsBefore = await page.$$eval('.card.collapsible:first-of-type .row', (r) => r.length)
  await page.click(firstToggle)
  const rowsFolded = await page.$$eval('.card.collapsible:first-of-type .row', (r) => r.length)
  check('a section folds down to its header', rowsBefore > 0 && rowsFolded === 0, `${rowsBefore} -> ${rowsFolded}`)
  await page.click(firstToggle)
  await page.waitForSelector('.card.collapsible:first-of-type .row')
  check('and unfolds again', true)
  await clickText('button', 'Collapse all')
  const open = await page.$$eval('.card-toggle[aria-expanded=true]', (e) => e.length)
  check('collapse all folds every section', open === 0, `${open} still open`)
  await clickText('button', 'Expand all')
  await page.waitForSelector('.row.clickable')
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('.row.clickable')].find((r) => r.textContent.includes('Power Attack'))
    row?.click()
  })
  await page.waitForSelector('.detail .detail-section', { timeout: 20000 })
  const panel = await page.$eval('.detail', (e) => e.innerText)
  check('side panel shows the feat title and its benefit text', panel.includes('Power Attack') && /penalty/i.test(panel), panel.slice(0, 120))
  await sleep(500) // let the panel finish sliding in
  await shot('detail')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.detail'), { timeout: 5000 })
  check('Escape closes the side panel', true)

  // Technical details stay tucked away until asked for
  await page.evaluate(() => [...document.querySelectorAll('.row.clickable')].find((r) => r.textContent.includes('Power Attack'))?.click())
  await page.waitForSelector('.detail .disclosure', { timeout: 20000 })
  const techShut = await page.evaluate(() => !document.querySelector('.detail .tech') && document.querySelector('.detail .disclosure').getAttribute('aria-expanded') === 'false')
  check('type tags are hidden behind "Technical details" by default', techShut)
  await page.click('.detail .disclosure')
  await page.waitForSelector('.detail .tech')
  check('and open when asked for', (await page.$eval('.detail .tech', (e) => e.innerText)).includes('Combat'))
  await page.keyboard.press('Escape')

  // Add picker: read a feat first; an exclusive trait explains the conflict and cannot be added
  await clickText('.card-title button', 'Add').catch(async () => {
    await page.evaluate(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add' && b.className.includes('primary'))?.click())
  })
  await page.waitForSelector('.split .pick', { timeout: 20000 })
  await page.type('.split .search input', 'Toughness')
  await sleep(700)
  await page.evaluate(() => [...document.querySelectorAll('.pick')].find((p) => p.textContent.includes('Toughness'))?.click())
  await page.waitForSelector('.split-preview .detail-section', { timeout: 20000 })
  const preview = await page.$eval('.split-preview', (e) => e.innerText)
  check('the Add picker previews what a feat does before adding it', /toughness/i.test(preview) && /benefit|description/i.test(preview), preview.slice(0, 100))
  await shot('picker')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.split'), { timeout: 5000 })

  await clickText('button[role=tab]', 'Biography')
  await page.waitForSelector('.chip.accent')
  await page.evaluate(() => {
    const head = [...document.querySelectorAll('.muted')].find((e) => e.textContent.trim().startsWith('Traits'))
    ;[...head.parentElement.querySelectorAll('button')].find((b) => b.textContent.includes('Add'))?.click()
  })
  await page.waitForSelector('.split .pick')
  await page.type('.split .search input', 'Reactionary')
  await sleep(700)
  await page.evaluate(() => [...document.querySelectorAll('.pick')].find((p) => p.textContent.includes('Reactionary'))?.click())
  await page.waitForSelector('.split-preview .notice.bad', { timeout: 20000 })
  const notice = await page.$eval('.split-preview .notice', (e) => e.innerText)
  check('an exclusive trait explains the conflict', /Combat Trait/.test(notice) && /Bloody-Minded/.test(notice), notice)
  check('its technical details are open because of the conflict', !!(await page.$('.split-preview .tech')))
  const addDisabled = await page.evaluate(() => [...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent.startsWith('Add'))?.disabled)
  check('and Add is disabled', addDisabled === true)
  await shot('conflict')
  await page.keyboard.press('Escape')

  // Spells open the same panel
  await clickText('button[role=tab]', 'Spells')
  await page.waitForSelector('.chip-link')
  await page.evaluate(() => [...document.querySelectorAll('.chip-link')].find((b) => b.textContent.trim() === 'Bless')?.click())
  await page.waitForSelector('.detail .detail-section', { timeout: 20000 })
  const spellPanel = await page.$eval('.detail', (e) => e.innerText)
  check('a spell opens the side panel with its school and components', /school/i.test(spellPanel) && /components/i.test(spellPanel), spellPanel.slice(0, 120))
  await sleep(400)
  await shot('spell')
  await page.keyboard.press('Escape')

  // Add spell: only the spell levels the class can use are offered, with a switch for the rest
  await clickText('button', 'Add spell')
  await page.waitForSelector('.level-filter .lvl')
  await page.waitForSelector('.split .pick')
  const chipLevels = () => page.$$eval('.level-filter .lvl', (c) => c.map((x) => x.textContent.trim().split(' ')[0]).filter((x) => x !== 'All'))
  const usableOnly = await chipLevels()
  check('the picker offers only the levels this class can use (Inquisitor 4: 0-2)', usableOnly.join(',') === '0,1,2', usableOnly.join(','))
  const toggleText = await page.$eval('.check-row', (e) => e.innerText)
  check('and says which higher levels are behind the switch', /3, 4, 5, 6/.test(toggleText), toggleText)
  await page.click('.check-row input')
  await sleep(300)
  const withHigher = await chipLevels()
  check('the switch brings in the higher levels', withHigher.join(',') === '0,1,2,3,4,5,6', withHigher.join(','))
  await page.evaluate(() => [...document.querySelectorAll('.level-filter .lvl')].find((b) => b.textContent.trim().startsWith('5 '))?.click())
  await sleep(300)
  const filteredRows = await page.$$eval('.split .pick', (e) => e.map((x) => x.querySelector('.row-sub').textContent))
  const chipCount = await page.evaluate(() => Number([...document.querySelectorAll('.level-filter .lvl')].find((b) => b.textContent.trim().startsWith('5 '))?.querySelector('.num')?.textContent))
  check('the level filter shows only that level, all of it', filteredRows.length > 0 && filteredRows.every((l) => l === 'Level 5') && filteredRows.length === chipCount, `${filteredRows.length} vs ${chipCount}`)
  // Inquisitors have a fixed spells-known table: a spell above their slots can be read about but not added
  await page.evaluate(() => [...document.querySelectorAll('.pick')].find((p) => p.textContent.includes("Alaznist"))?.click())
  await page.waitForSelector('.split-preview .notice.warn', { timeout: 20000 })
  const addState = await page.evaluate(() => [...document.querySelectorAll('.modal-foot button')].find((x) => x.textContent.startsWith('Add'))?.disabled)
  const noteText = await page.$eval('.split-preview .notice.warn', (e) => e.innerText)
  check('a spell above a fixed-table class\'s slots is explained and not addable', addState === true && /fixed number/.test(noteText), noteText)
  await shot('spell-filter')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.split'), { timeout: 20000 })

  // Spells the character already holds above what the class can cast are flagged red
  const flags = await page.evaluate(() => ({
    badChip: [...document.querySelectorAll('.chip.bad')].some((c) => c.textContent.includes('Angelic Aspect')),
    badHeaders: [...document.querySelectorAll('.muted .chip.bad')].length,
    castableFlagged: [...document.querySelectorAll('.chip.bad')].some((c) => ['Bless', 'Light', 'Guidance'].some((n) => c.textContent.includes(n))),
  }))
  check('known spells above the class\'s reach are flagged red', flags.badChip)
  check('uncastable levels carry a red header tag, castable spells stay normal', flags.badHeaders >= 1 && !flags.castableFlagged, JSON.stringify(flags))
  await shot('spells-flagged')

  // Half-orc favoured class bonus: used to be refused for every half-orc (a data bug); now it is offered
  await clickText('button[role=tab]', 'Class')
  await page.waitForSelector('.card.collapsible')
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('.card.collapsible')].find((c) => c.querySelector('.card-toggle')?.textContent.includes('Favored Class Bonus'))
    ;[...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Add')?.click()
  })
  await page.waitForSelector('.split .pick', { timeout: 20000 })
  await sleep(500)
  const fcbShort = await page.$$eval('.split .pick', (e) => e.length)
  const fcbChecked = await page.$eval('.check-row input', (e) => e.checked)
  check('the favoured class bonus list starts with only what the character qualifies for', fcbChecked && fcbShort > 0 && fcbShort <= 15, `${fcbShort} entries, checked=${fcbChecked}`)
  await page.click('.check-row input')
  await sleep(700)
  const fcbAll = await page.$$eval('.split .pick', (e) => e.length)
  check('and the full list is one click away', fcbAll > 50, `${fcbAll} entries`)
  await page.click('.check-row input')
  await sleep(500)
  await page.type('.split .search input', 'Intimidate & Identify')
  await sleep(700)
  await page.evaluate(() => [...document.querySelectorAll('.pick')].find((p) => p.textContent.includes('Intimidate & Identify'))?.click())
  await page.waitForSelector('.split-preview .detail-section', { timeout: 20000 })
  const fcbNotice = await page.$('.split-preview .notice.bad')
  const fcbAdd = await page.evaluate(() => ![...document.querySelectorAll('.modal-foot button')].find((x) => x.textContent.startsWith('Add'))?.disabled)
  check('a half-orc Inquisitor can take the half-orc favoured class bonus', !fcbNotice && fcbAdd)
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => !document.querySelector('.split'), { timeout: 5000 })

  // Gear: customise, add masterwork, cancel
  await clickText('button[role=tab]', 'Gear')
  await page.waitForSelector('.search input')
  await page.type('.search input', 'Longsword')
  await page.waitForSelector('.result-list .result')
  // The data set has plain and pre-enchanted longswords; customise the plain one.
  const clicked = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.result-list .result')].find((r) => r.querySelector('.row-title')?.textContent === 'Longsword')
    const btn = row && [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Customize')
    btn?.click()
    return !!btn
  })
  if (!clicked) throw new Error('no plain Longsword in the shop results')
  await page.waitForSelector('.modal', { timeout: 20000 })
  await waitText('Customize Longsword')
  check('customiser dialog opens', true)
  await page.type('.modal .search input', 'masterwork')
  await sleep(600)
  await clickText('.modal .result', 'Masterwork')
  await waitText('Masterwork (Weapon)')
  check('applied enchantment is listed', true)
  await shot('builder')
  await clickText('.modal button', 'Cancel')
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 20000 })
  check('cancelling the customiser closes it', true)

  // Sheet: generate and preview the PDF
  await clickText('button[role=tab]', 'Sheet')
  await page.waitForSelector('select[aria-label="Sheet design"]')
  await page.waitForFunction(
    () => [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Generate' && !b.disabled),
    { timeout: 20000 },
  )
  await clickText('button', 'Generate')
  await page.waitForSelector('iframe.preview', { timeout: 60000 })
  check('PDF preview renders', true)
  await shot('sheet')

  // The engine asks which ability score to raise when reaching level 4: set that up, then answer it in the UI.
  await fetch(`http://127.0.0.1:8765/characters/${id}/levels?count=${levels - 3}`, { method: 'DELETE' })
  await page.goto('about:blank') // a hash-only change would not reload the app
  await page.goto(URL + '#Overview', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelectorAll('.level-row').length === 3, { timeout: 20000 })
  await clickText('button', 'Level up')
  await page.waitForSelector('.modal .pick')
  await page.type('.modal input', 'Inquisitor')
  await sleep(500)
  await pickFrom('Inquisitor')
  await page.waitForSelector('.modal .choice', { timeout: 30000 })
  check('level 4 raises the ability-score question', (await text()).includes('ability score'))
  await shot('chooser')
  const before = await page.evaluate(() => document.querySelector('.ability .ability-edit')?.value)
  await page.click('.modal .choice') // first option: Strength
  await clickText('.modal button', 'Confirm')
  await page.waitForFunction(() => document.querySelectorAll('.level-row').length === 4, { timeout: 30000 })
  await page.waitForFunction(() => /Hit points for level/.test(document.querySelector('.modal')?.innerText ?? ''), { timeout: 20000 })
  await clickText('.modal button', 'Roll d')
  await sleep(400)
  await clickText('.modal button', 'Save')
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 20000 })
  const after = await page.evaluate(() => document.querySelector('.ability .ability-edit')?.value)
  check('the chosen ability score went up by one', Number(after) === Number(before) + 1, `${before} -> ${after}`)
  await clickText('.modal button', 'Cancel').catch(() => {})

  // Details panels for skills, gear and classes, and the reading pane in the race picker.
  const sidePanel = () => page.evaluate(() => document.querySelector('.detail')?.innerText ?? '')
  await clickText('.tabs button', 'Skills')
  await page.waitForSelector('table .link-btn')
  await page.click('table .link-btn')
  await page.waitForFunction(() => document.querySelector('.detail .detail-body')?.innerText.length > 40, { timeout: 20000 })
  check('a skill opens its description in the side panel', /Skill/.test(await sidePanel()))
  await page.keyboard.press('Escape')
  await clickText('.tabs button', 'Gear')
  await page.waitForSelector('.rows .link-btn')
  await page.click('.rows .link-btn')
  await page.waitForFunction(() => document.querySelector('.detail .detail-body')?.innerText.length > 20, { timeout: 20000 })
  check('an item opens its description in the side panel', /Equipment/.test(await sidePanel()))
  await page.keyboard.press('Escape')
  // Gear: the load bar, and equipping an item that can go in more than one place asks where.
  await page.waitForFunction(() => /Light to \d+/.test(document.body.innerText), { timeout: 20000 })
  check('the load shows the light / medium / heavy limits', /Medium to \d+/.test(await text()) && /Heavy to \d+/.test(await text()))
  await page.evaluate(() => [...[...document.querySelectorAll('.rows .row')].find((r) => r.innerText.startsWith('Longsword'))?.querySelectorAll('button') ?? []].find((b) => b.innerText.trim() === 'Equip')?.click())
  await page.waitForFunction(() => /Where should it go/.test(document.querySelector('.modal')?.innerText ?? ''), { timeout: 20000 })
  const places = await page.$$eval('.modal .choice', (els) => els.length)
  check('equipping an item with several places asks where', places >= 2, String(places))
  await page.evaluate(() => document.querySelector('.modal .choice')?.click())
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 20000 })
  await page.waitForFunction(() => [...document.querySelectorAll('.rows .row')].some((r) => r.innerText.startsWith('Longsword') && /in use/.test(r.innerText)), { timeout: 20000 })
  check('the item is then marked in use', true)

  // Charges and notes on a wand, and the upgrade dialog's pay-or-free choice.
  await fetch(`http://127.0.0.1:8765/characters/${id}`, { method: 'PATCH', body: JSON.stringify({ funds: '20000' }) })
  await fetch(`http://127.0.0.1:8765/characters/${id}/equipment/buy`, { method: 'POST', body: JSON.stringify({ item: 'Wand of Acid Arrow', quantity: 1 }) })
  await page.reload({ waitUntil: 'networkidle0' })
  await clickText('.tabs button', 'Gear')
  await page.waitForFunction(() => [...document.querySelectorAll('.rows .row')].some((r) => r.innerText.startsWith('Wand of Acid Arrow') && /50\/50/.test(r.innerText)), { timeout: 20000 })
  check('a wand shows its charges', true)
  const wandRow = () => page.evaluate(() => [...document.querySelectorAll('.rows .row')].find((r) => r.innerText.startsWith('Wand of Acid Arrow'))?.innerText ?? '')
  await page.click('button[aria-label="Use a charge of Wand of Acid Arrow"]')
  await page.waitForFunction(() => [...document.querySelectorAll('.rows .row')].some((r) => r.innerText.startsWith('Wand of Acid Arrow') && /49\/50/.test(r.innerText)), { timeout: 20000 })
  check('using a charge counts it down', true)
  await page.evaluate(() => [...[...document.querySelectorAll('.rows .row')].find((r) => r.innerText.startsWith('Wand of Acid Arrow'))?.querySelectorAll('button') ?? []].find((b) => b.innerText.trim() === 'Add note' || b.innerText.trim() === 'Edit note')?.click())
  await page.waitForSelector('.modal input')
  await page.type('.modal input', 'Found in the crypt')
  await clickText('.modal button', 'Save')
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 20000 })
  await page.waitForFunction(() => [...document.querySelectorAll('.rows .row')].some((r) => r.innerText.startsWith('Wand of Acid Arrow') && r.innerText.includes('Found in the crypt')), { timeout: 20000 })
  check('a note shows under the item', /Found in the crypt/.test(await wandRow()))
  await page.evaluate(() => [...[...document.querySelectorAll('.rows .row')].find((r) => r.innerText.startsWith('Longsword'))?.querySelectorAll('button') ?? []].find((b) => b.innerText.trim() === 'Customize')?.click())
  await page.waitForFunction(() => /Customize Longsword/.test(document.querySelector('.modal')?.innerText ?? ''), { timeout: 20000 })
  const payText = await page.$eval('.modal', (m) => m.innerText)
  check('the upgrade dialog asks whether the character pays', /pays for the upgrade/.test(payText) && /taken from the character/.test(payText))
  await page.evaluate(() => document.querySelector('.modal input[type=checkbox]')?.click())
  await page.waitForFunction(() => /free/.test(document.querySelector('.modal')?.innerText ?? ''), { timeout: 5000 })
  check('unticking it makes the upgrade free', true)
  await clickText('.modal button', 'Cancel')
  // An enchantment that asks a question (Add Type asks which types) must open that question on top of the builder.
  await page.evaluate(() => [...[...document.querySelectorAll('.rows .row')].find((r) => r.innerText.startsWith('Wand of Acid Arrow'))?.querySelectorAll('button') ?? []].find((b) => b.innerText.trim() === 'Customize')?.click())
  await page.waitForFunction(() => /Customize Wand of Acid Arrow/.test(document.querySelector('.modal')?.innerText ?? ''), { timeout: 20000 })
  await clickText('.modal button', 'Open the item builder')
  await page.waitForFunction(() => [...document.querySelectorAll('.scrim .result')].some((x) => /Add Type/.test(x.innerText)), { timeout: 30000 })
  await page.evaluate(() => [...document.querySelectorAll('.scrim .result')].find((x) => /Add Type/.test(x.innerText))?.click())
  await page.waitForFunction(() => /Select desired TYPE/.test([...document.querySelectorAll('.scrim')].at(-1)?.innerText ?? ''), { timeout: 20000 })
  check('a question asked while building opens above the builder, not behind it', true)
  await page.evaluate(() => [...[...document.querySelectorAll('.scrim')].at(-1).querySelectorAll('button')].find((b) => b.innerText.trim() === 'Cancel')?.click())
  await page.waitForFunction(() => document.querySelectorAll('.scrim').length === 1, { timeout: 20000 })
  await page.evaluate(() => [...document.querySelectorAll('.scrim button')].find((b) => b.innerText.trim() === 'Cancel')?.click())
  await page.waitForFunction(() => document.querySelectorAll('.scrim').length === 0, { timeout: 20000 })
  check('the builder closes cleanly afterwards', true)
  await clickText('.tabs button', 'Overview')
  await page.waitForSelector('.level-row .link-btn')
  await page.click('.level-row .link-btn')
  await page.waitForFunction(() => document.querySelector('.detail .detail-body')?.innerText.length > 40, { timeout: 20000 })
  check('a class in the level list opens its description', /Class/.test(await sidePanel()))
  await page.keyboard.press('Escape')
  await clickText('.vital button', 'Change') // the first Change button is the race
  await page.waitForSelector('.split .pick')
  await page.click('.split .pick')
  await page.waitForFunction(() => document.querySelector('.split-preview .preview-title'), { timeout: 20000 })
  check('the race picker reads out what a race does', (await page.evaluate(() => document.querySelector('.split-preview')?.innerText.length)) > 60)
  await page.keyboard.press('Escape')

  // A brand-new character goes through the guided wizard: name + point-buy scores, race, class.
  await clickText('.sidebar-actions button', 'New')
  await page.waitForFunction(() => /New character/.test(document.querySelector('.modal')?.innerText ?? ''), { timeout: 20000 })
  check('New opens the wizard', true)
  await page.type('.modal input', 'Wizard Test') // the name field selects its text on focus
  await clickText('.modal button', 'Point buy')
  await clickText('.modal button', 'Next')
  await waitText('Choose a race')
  await clickText('.modal button', 'Choose a race')
  await page.waitForSelector('.modal .pick')
  await page.type('.modal input', 'Human')
  await sleep(500)
  await pickFrom('Human')
  await page.waitForFunction(() => /Race\s*Human/.test(document.querySelector('.modal')?.innerText ?? ''), { timeout: 20000 })
  check('the wizard sets the race', true)
  await clickText('.modal button', 'Next')
  await clickText('.modal button', 'Choose a class')
  await page.waitForSelector('.modal .pick')
  await page.type('.modal input', 'Wizard')
  await sleep(500)
  await pickFrom('Wizard')
  // The engine may ask questions on the way (abilities final? which school?): answer each until the level is added.
  for (let i = 0; i < 8 && !(await text()).includes('Level 1 hit points'); i++) {
    await page
      .waitForFunction(
        () =>
          /Level 1 hit points/.test(document.body.innerText) ||
          document.querySelector('.modal .choice') ||
          [...document.querySelectorAll('.modal button')].some((b) => b.innerText.trim() === 'Continue'),
        { timeout: 30000 },
      )
    if ((await text()).includes('Level 1 hit points')) break
    if (await page.$('.modal .choice')) {
      await page.click('.modal .choice')
      await clickText('.modal button', 'Confirm')
    } else await clickText('.modal button', 'Continue')
    await sleep(400)
  }
  await waitText('Level 1 hit points')
  check('the wizard adds the first class level', true)
  await shot('wizard')
  await clickText('.modal button', 'Next')
  await waitText('is ready')
  // Starting gold is offered to a first-level character; it asks how, and the money appears.
  await waitText('Get starting gold')
  await clickText('.modal button', 'Get starting gold')
  await page.waitForSelector('.modal .choice')
  check('starting gold asks how, in plain words', (await text()).includes('Roll for it') && (await text()).includes('Take the average'))
  await clickText('.modal .choice', 'Take the maximum')
  await clickText('.modal button', 'Confirm')
  await page.waitForFunction(() => /[1-9]\d* gp/.test(document.querySelector('.modal')?.innerText ?? ''), { timeout: 20000 })
  check('the starting gold lands in the funds', true)
  await clickText('.modal button', 'Finish')
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 20000 })
  check('the wizard finishes', (await page.$$('.level-row')).length === 1)

  // A new wizard knows no spells yet but can add some.
  await clickText('.tabs button', 'Spells')
  await waitText('Add to spellbook')
  check('a new caster can add spells before knowing any', (await text()).includes('No spells chosen yet'))
  // Learn a cantrip, prepare it, and see the daily count change.
  const pickFirstAndConfirm = async (verb) => {
    await page.waitForSelector('.modal .pick')
    await page.click('.modal .pick')
    await page.waitForFunction((v) => [...document.querySelectorAll('.modal button')].some((b) => b.innerText.trim().startsWith(v + ' ') && !b.disabled), { timeout: 20000 }, verb)
    await clickText('.modal button', verb + ' ')
    await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 20000 })
  }
  await clickText('button', 'Add to spellbook')
  await pickFirstAndConfirm('Add')
  await page.waitForFunction(() => /in the spellbook/i.test(document.body.innerText), { timeout: 20000 }) // headings are shown in capitals
  check('a spell can be added to a spellbook', true)
  await clickText('button', 'Prepare spell')
  await pickFirstAndConfirm('Prepare')
  await page.waitForFunction(() => /Level 0: 1\/\d+ prepared/.test(document.body.innerText), { timeout: 20000 })
  check('preparing a spell shows how many slots are used', true)
  await shot('spells-prepared')
  await clickText('.tabs button', 'Overview')

  // Save for a never-saved character asks where, and writes the file.
  const saveDir = resolve('..', '.run')
  const outFile = resolve(saveDir, 'e2e-saveas.pcg')
  rmSync(outFile, { force: true })
  await page.evaluate((d) => localStorage.setItem('pcgen.ui.saveDir', d), saveDir)
  await clickText('button', 'Save')
  await page.waitForFunction(() => /Save character/.test(document.querySelector('.modal')?.innerText ?? ''), { timeout: 20000 })
  check('Save on an unsaved character opens Save As', true)
  await page.waitForSelector('.modal label input')
  await page.$eval('.modal label input', (el) => (el.value = ''))
  await page.type('.modal label input', 'e2e-saveas')
  await clickText('.modal button', 'Save')
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 20000 })
  await sleep(500)
  check('Save As writes the .pcg file', existsSync(outFile))
  rmSync(outFile, { force: true })

  // Metamagic: a generated wizard whose only metamagic feat is Aquatic Spell (+1 level). Work on a copy.
  const wizCopy = resolve(saveDir, 'e2e-wizard5.pcg')
  copyFileSync(resolve('..', 'harness', 'characters', 'corpus_wizard5.pcg'), wizCopy)
  let opened = await (await fetch('http://127.0.0.1:8765/characters', { method: 'POST', body: JSON.stringify({ path: wizCopy }) })).json()
  while (opened.pendingConfirm || opened.pendingChooser) {
    opened = opened.pendingConfirm
      ? await (await fetch(`http://127.0.0.1:8765/confirms/${opened.pendingConfirm.id}`, { method: 'POST', body: JSON.stringify({ ok: true }) })).json()
      : await (await fetch(`http://127.0.0.1:8765/choosers/${opened.pendingChooser.id}`, { method: 'POST', body: JSON.stringify({ cancel: true }) })).json()
  }
  const wizId = opened.id
  await fetch(`http://127.0.0.1:8765/characters/${wizId}/spells/known`, { method: 'POST', body: JSON.stringify({ class: 'Wizard', level: '1', spell: 'Magic Missile' }) })
  await page.reload({ waitUntil: 'networkidle0' }) // a hash-only goto would not reload the character list
  await page.waitForFunction(() => [...document.querySelectorAll('.char-item')].some((e) => e.innerText.includes('Wizard5')), { timeout: 20000 })
  await page.evaluate(() => [...document.querySelectorAll('.char-item')].find((e) => e.innerText.includes('Wizard5'))?.click())
  await page.waitForFunction(() => /Corpus Wizard5/.test(document.querySelector('.hero-name')?.value ?? ''), { timeout: 20000 })
  // Switching character resets to the Overview a moment after it loads, so keep opening Spells until it sticks.
  for (let i = 0; i < 10 && !(await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Prepare spell'))); i++) {
    await sleep(700)
    await clickText('.tabs button', 'Spells')
  }
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Prepare spell'), { timeout: 20000 })
  await clickText('button', 'Prepare spell')
  await page.waitForSelector('.modal .pick')
  await page.evaluate(() => [...document.querySelectorAll('.modal .pick')].find((e) => e.innerText.includes('Magic Missile'))?.click())
  await page.waitForFunction(() => /Metamagic/.test(document.querySelector('.modal')?.innerText ?? ''), { timeout: 20000 })
  const featsOffered = await page.evaluate(() => [...document.querySelectorAll('.modal .check-row')].map((e) => e.innerText.trim()))
  check('only the characters own metamagic feat is offered', featsOffered.length === 1 && featsOffered[0].startsWith('Aquatic Spell'), featsOffered.join(' | '))
  await page.evaluate(() => document.querySelector('.modal .check-row input')?.click())
  await page.waitForFunction(() => /Prepared as a level 2 spell/.test(document.querySelector('.modal')?.innerText ?? ''), { timeout: 10000 })
  check('metamagic shows the slot level the spell will take', true)
  await shot('metamagic')
  await clickText('.modal button', 'Prepare ')
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 20000 })
  await page.waitForFunction(() => /Magic Missile\s*\(Aquatic Spell\)/.test(document.body.innerText) && /Level 2: 1\/3 prepared/.test(document.body.innerText), { timeout: 20000 })
  check('the metamagic spell is prepared in a level 2 slot', true)
  rmSync(wizCopy, { force: true })

  // GM-granted feat: ticking the box lifts the prerequisite check; the feat is marked GM and can be taken back.
  await clickText('.tabs button', 'Feats')
  await page.waitForFunction(() => !!document.querySelector('section[data-section="FEAT"]'), { timeout: 20000 })
  await page.evaluate(() => [...document.querySelectorAll('section[data-section="FEAT"] button')].find((b) => b.innerText.trim() === 'Add')?.click())
  await page.waitForSelector('.modal .pick')
  await page.evaluate(() => [...document.querySelectorAll('.modal .check-row')].find((l) => /GM/.test(l.innerText))?.querySelector('input')?.click())
  await page.type('.modal input[placeholder="Search"]', 'Whirlwind')
  await sleep(1200)
  await page.evaluate(() => [...document.querySelectorAll('.modal .pick')].find((p) => p.innerText.includes('Whirlwind Attack'))?.click())
  await page.waitForFunction(() => [...document.querySelectorAll('.modal button')].some((b) => b.innerText.trim().startsWith('Grant ') && !b.disabled), { timeout: 20000 })
  check('a GM grant can be added even though the feat has unmet prerequisites', true)
  await clickText('.modal button', 'Grant ')
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 20000 })
  await page.waitForFunction(() => [...document.querySelectorAll('section[data-section="FEAT"] .row')].some((r) => r.innerText.includes('Whirlwind Attack') && /GM/.test(r.innerText)), { timeout: 20000 })
  check('the granted feat is marked GM in the list', true)
  await page.evaluate(() => [...document.querySelectorAll('section[data-section="FEAT"] .row')].find((r) => r.innerText.includes('Whirlwind Attack'))?.querySelector('button.danger')?.click())
  await page.waitForFunction(() => ![...document.querySelectorAll('section[data-section="FEAT"] .row')].some((r) => r.innerText.includes('Whirlwind Attack')), { timeout: 20000 })
  check('and it can be taken back', true)
  // The "also give a bonus feat slot" tick (on by default) added one slot; the stepper shows it and can change it.
  const slotCount = () => page.evaluate(() => Number(document.querySelector('section[data-section="FEAT"] .stepper b')?.innerText ?? '-1'))
  const slotsNow = await slotCount()
  check('the GM bonus slot count shows on the feats card and includes the slot the grant added', slotsNow >= 1, slotsNow)
  await page.click('button[aria-label="Take away a GM bonus feat slot"]')
  await page.waitForFunction((n) => Number(document.querySelector('section[data-section="FEAT"] .stepper b')?.innerText) === n - 1, { timeout: 20000 }, slotsNow)
  check('a GM bonus slot can be taken away with the minus button', true)
  // The GM awards card lists PCGen's awards and can add any of them; languages from the GM are given on Biography.
  await page.waitForSelector('section[data-section="GM Awards"]', { timeout: 20000 })
  check('the feats tab has a GM awards card with an Add button', await page.evaluate(() => [...document.querySelectorAll('section[data-section="GM Awards"] button')].some((b) => b.innerText.trim() === 'Add')))
  await clickText('.tabs button', 'Biography')
  await page.waitForSelector('select[aria-label="Language to give"]', { timeout: 20000 })
  const gift = await page.evaluate(() => document.querySelector('select[aria-label="Language to give"]').options[1].value)
  await page.select('select[aria-label="Language to give"]', gift)
  await clickText('.card button', 'Give')
  await page.waitForFunction((g) => !!document.querySelector(`button[aria-label="Take back ${g}"]`), { timeout: 20000 }, gift)
  check('a language given by the GM shows with a GM mark', true)
  await page.click(`button[aria-label="Take back ${gift}"]`)
  await page.waitForFunction((g) => !document.querySelector(`button[aria-label="Take back ${g}"]`), { timeout: 20000 }, gift)
  check('and can be taken back', true)

  // Deity picker: searching by domain finds gods, and choosing one changes the character's deity.
  await clickText('.tabs button', 'Overview')
  await page.waitForFunction(() => [...document.querySelectorAll('.vital')].some((v) => v.innerText.startsWith('Deity')), { timeout: 20000 })
  // Clicking into an ability score and out again without typing must not change it (it used to save 0), and Escape
  // must throw away what was typed.
  const strBox = 'input[aria-label="Strength base score"]'
  const strBefore = await page.$eval(strBox, (e) => e.value)
  await page.click(strBox)
  await page.$eval(strBox, (e) => e.blur())
  await sleep(1200)
  check('clicking into an ability score and away leaves it alone', (await page.$eval(strBox, (e) => e.value)) === strBefore && Number(strBefore) > 0, [strBefore, await page.$eval(strBox, (e) => e.value)])
  await page.click(strBox)
  await page.keyboard.type('3')
  await page.keyboard.press('Escape')
  await sleep(1200)
  check('Escape discards a typed ability score', (await page.$eval(strBox, (e) => e.value)) === strBefore, await page.$eval(strBox, (e) => e.value))
  await page.evaluate(() => [...document.querySelectorAll('.vital')].find((v) => v.innerText.startsWith('Deity'))?.querySelector('button.small')?.click())
  await page.waitForSelector('.modal .pick')
  const allGods = await page.$$eval('.modal .pick', (els) => els.length)
  await page.type('.modal input[placeholder="Search"]', 'fire')
  await sleep(1200)
  const fireGods = await page.$$eval('.modal .pick', (els) => els.map((e) => e.innerText.slice(0, 20)))
  check('searching deities by domain narrows the list', fireGods.length > 0 && fireGods.length < allGods, `${allGods} -> ${fireGods.length}`)
  await page.evaluate(() => document.querySelector('.modal .pick')?.click())
  await page.waitForFunction(() => [...document.querySelectorAll('.modal button')].some((b) => b.innerText.trim().startsWith('Choose ') && !b.disabled), { timeout: 20000 })
  const chosenGod = await page.evaluate(() => [...document.querySelectorAll('.modal button')].find((b) => b.innerText.trim().startsWith('Choose '))?.innerText.trim().slice(7))
  await clickText('.modal button', 'Choose ')
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 20000 })
  await page.waitForFunction((g) => [...document.querySelectorAll('.vital')].some((v) => v.innerText.startsWith('Deity') && v.innerText.includes(g)), { timeout: 20000 }, chosenGod)
  check('choosing a deity sets it on the character', true)
} catch (e) {
  check('test run completed', false, String(e) + ' @ ' + String(e.stack ?? '').split('\n').find((l) => l.includes('smoke.mjs')))
  await shot('failure').catch(() => {})
} finally {
  await browser.close()
}

const bad = results.filter((r) => !r[1]).length
console.log(`${results.length - bad}/${results.length} checks passed`)
process.exit(bad ? 1 : 0)
