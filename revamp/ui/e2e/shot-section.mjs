// Screenshot of one part of a tab: node e2e/shot-section.mjs <tab> <css selector or text of a card title> <output-name>
// Like shot.mjs, but scrolls the part into view first (for things below the fold).
import puppeteer from 'puppeteer-core'

const [tab = 'Overview', what = '', out = 'section'] = process.argv.slice(2)
const EDGE = process.env.BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const b = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox'] })
const p = await b.newPage()
await p.setViewport({ width: 1440, height: 1100 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await p.goto('http://127.0.0.1:5173/#' + tab, { waitUntil: 'networkidle0' })
await sleep(1500)
await p.evaluate((t) => [...document.querySelectorAll('.tabs button')].find((e) => e.innerText.trim().startsWith(t))?.click(), tab)
await sleep(1500)
const found = await p.evaluate((w) => {
  let el = null
  try {
    el = document.querySelector(w)
  } catch {
    /* not a selector: fall through to the text search */
  }
  el ??= [...document.querySelectorAll('.card')].find((c) => (c.querySelector('.card-title')?.innerText ?? '').toLowerCase().includes(w.toLowerCase()))
  el?.scrollIntoView({ block: 'start' })
  return !!el
}, what)
if (!found) console.log('not found:', what)
await sleep(600)
await p.screenshot({ path: `../.run/shots/${out}.png` })
await b.close()
