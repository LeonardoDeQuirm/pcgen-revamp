// Quick screenshot helper: node e2e/shot.mjs <tab> <character-name-fragment> <output-name>
// Opens the running UI, selects the character whose sidebar entry contains the fragment, opens the tab, saves a PNG.
import puppeteer from 'puppeteer-core'

const [tab = 'Overview', who = '', out = 'shot'] = process.argv.slice(2)
const EDGE = process.env.BROWSER ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const b = await puppeteer.launch({ executablePath: EDGE, headless: true, args: ['--no-sandbox'] })
const p = await b.newPage()
await p.setViewport({ width: 1440, height: 1100 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
await p.goto('http://127.0.0.1:5173/#' + tab, { waitUntil: 'networkidle0' })
await sleep(1500)
if (who) {
  await p.evaluate((n) => [...document.querySelectorAll('.char-item')].find((e) => e.innerText.includes(n))?.click(), who)
  await sleep(1000)
}
await p.evaluate((t) => [...document.querySelectorAll('.tabs button')].find((e) => e.innerText.trim().startsWith(t))?.click(), tab)
await sleep(1500)
await p.screenshot({ path: `../.run/shots/${out}.png` })
await b.close()
