// Smoke driver: launch the built Remote Agent app, screenshot, poke the UI.
import { _electron as electron } from 'playwright-core'
import * as fs from 'node:fs'

const APP_DIR = '/home/will/Documents/remote_agent'
const SHOTS = '/tmp/claude-1000/-home-will-Documents-remote-agent/20992b23-0222-4831-be74-f75915524a32/scratchpad/shots'
fs.mkdirSync(SHOTS, { recursive: true })

const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
delete env.ELECTRON_RUN_AS_NODE // Claude Code sets this; it makes the binary act as plain Node
const app = await electron.launch({
  executablePath: APP_DIR + '/node_modules/electron/dist/electron',
  args: ['--no-sandbox', APP_DIR],
  env,
  timeout: 30_000
})

const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await new Promise((r) => setTimeout(r, 2500))

const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})

console.log('URL:', page.url())
console.log('TITLE:', await page.title())
await page.screenshot({ path: SHOTS + '/01-welcome.png' })
console.log('BODY TEXT:', JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 400)))

// ping over the real IPC bridge
console.log('PING:', await page.evaluate(() => window.api.ping()))

// open the Add host dialog
const clicked = await page.evaluate(() => {
  const els = [...document.querySelectorAll('button')]
  const el = els.find((e) => e.textContent && e.textContent.toLowerCase().includes('add host'))
  if (!el) return 'NOT_FOUND: ' + els.map((e) => e.textContent?.trim()).join(' | ')
  el.click()
  return 'OK'
})
console.log('CLICK add-host:', clicked)
await new Promise((r) => setTimeout(r, 800))
await page.screenshot({ path: SHOTS + '/02-host-dialog.png' })
console.log('DIALOG TEXT:', JSON.stringify((await page.evaluate(() => document.body.innerText)).slice(0, 600)))
console.log('CONSOLE ERRORS:', consoleErrors.length ? consoleErrors : 'none')

await app.close()
console.log('SMOKE OK')
