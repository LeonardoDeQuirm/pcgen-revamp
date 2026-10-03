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
import { mkdirSync } from 'node:fs'

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
const shot = (name) => page.screenshot({ path: `../.run/shots/e2e-${name}.png` })

try {
  // Open the character through the same API the dialog uses, then load the UI.
  // (start-dev.ps1 already opened it; a second open just answers "already open", which is fine.)
  await fetch('http://127.0.0.1:8765/characters', { method: 'POST', body: JSON.stringify({ path: charPath }) })
  const id = charPath.split(/[\/]/).pop().replace(/\.[^.]*$/, '')
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
  await page.waitForSelector('.modal .result')
  await page.type('.modal input', 'Fighter')
  await sleep(500)
  await clickText('.modal .result', 'Fighter')
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
  await page.waitForSelector('.modal .result')
  await page.type('.modal input', 'Inquisitor')
  await sleep(500)
  await clickText('.modal .result', 'Inquisitor')
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

  // A brand-new character: the first level asks "are your abilities set as you'd like them?"
  await clickText('.sidebar-actions button', 'New')
  await page.waitForFunction(() => document.querySelectorAll('.char-item').length === 2, { timeout: 20000 })
  await page.waitForSelector('.ability')
  await clickText('button', 'Level up')
  await page.waitForSelector('.modal .result')
  await page.type('.modal input', 'Wizard')
  await sleep(500)
  await clickText('.modal .result', 'Wizard')
  await page.waitForFunction(() => /abilit/i.test(document.querySelector('.modal')?.innerText ?? ''), { timeout: 20000 })
  check('the first level asks a yes/no question in a dialog', true)
  await shot('confirm')
  await clickText('.modal button', 'Go back')
  await page.waitForFunction(() => !document.querySelector('.modal'), { timeout: 20000 })
  check('going back adds no level', (await page.$$('.level-row')).length === 0)
} catch (e) {
  check('test run completed', false, String(e))
  await shot('failure').catch(() => {})
} finally {
  await browser.close()
}

const bad = results.filter((r) => !r[1]).length
console.log(`${results.length - bad}/${results.length} checks passed`)
process.exit(bad ? 1 : 0)
