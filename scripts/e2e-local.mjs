// Full-loop E2E against a throwaway local sshd (see scripts/smoke.mjs for the plain smoke).
// Drives the real app: add host -> connect -> helper bootstrap -> project -> worktree
// session -> tmux terminal -> file viewer. Setup goes through window.api (the real IPC
// bridge + main process + ssh2 + helper); verification happens through the rendered UI.
//
// Env: E2E_SSH_PORT (default 2299), E2E_KEY (client key path), E2E_REPO (test repo path)
import { _electron as electron } from 'playwright-core'
import { execSync } from 'node:child_process'
import * as fs from 'node:fs'

const APP_DIR = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const SHOTS = process.env.SCREENSHOT_DIR || '/tmp/ra-e2e-shots'
const PORT = Number(process.env.E2E_SSH_PORT || 2299)
const KEY = process.env.E2E_KEY
const REPO = process.env.E2E_REPO
if (!KEY || !REPO) {
  console.error('set E2E_KEY and E2E_REPO')
  process.exit(1)
}
fs.mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (n) => console.log('\n=== ' + n + ' ===')

const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
delete env.ELECTRON_RUN_AS_NODE

const app = await electron.launch({
  executablePath: APP_DIR + '/node_modules/electron/dist/electron',
  args: ['--no-sandbox', APP_DIR],
  env,
  timeout: 30_000
})
let page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await sleep(2000)
const errors = []
const hookErrors = (p) => p.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
hookErrors(page)

const body = () => page.evaluate(() => document.body.innerText)
const clickText = (t) =>
  page.evaluate((txt) => {
    // prefer buttons, else click the leaf element with the exact text and let it bubble
    const buttons = [...document.querySelectorAll('button')]
    const btn =
      buttons.find((e) => e.textContent && e.textContent.trim() === txt) ??
      buttons.find((e) => e.textContent && e.textContent.includes(txt))
    if (btn) {
      btn.click()
      return 'OK<BUTTON>'
    }
    const leaves = [...document.querySelectorAll('*')].filter(
      (e) => e.children.length === 0 && e.textContent && e.textContent.trim() === txt
    )
    if (!leaves.length) return 'NOT_FOUND'
    leaves[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    return 'OK<' + leaves[0].tagName + '>'
  }, t)
const waitBody = async (txt, ms = 15000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if ((await body()).includes(txt)) return true
    await sleep(400)
  }
  return false
}

let hostId = ''
let projectId = ''
let session = null
const cleanup = { host: false, project: false, session: false }

try {
  step('1. save host via api')
  const host = await page.evaluate(
    ([port, key]) =>
      window.api.hostsSave({
        label: 'e2e-local',
        host: '127.0.0.1',
        port,
        username: 'will',
        authKind: 'key',
        keyPath: key
      }),
    [PORT, KEY]
  )
  hostId = host.id
  cleanup.host = true
  console.log('host saved:', host.id, host.label)

  step('2. test connection via api')
  const test = await page.evaluate(
    ([id, port, key]) =>
      window.api.hostsTest({
        id,
        label: 'e2e-local',
        host: '127.0.0.1',
        port,
        username: 'will',
        authKind: 'key',
        keyPath: key
      }),
    [hostId, PORT, KEY]
  )
  console.log('hostsTest:', JSON.stringify(test))
  if (!test.ok) throw new Error('hostsTest failed: ' + test.error)

  step('3. reload UI, connect through the real button')
  await page.reload()
  await sleep(1500)
  hookErrors(page)
  console.log('ui:', JSON.stringify((await body()).slice(0, 200)))
  console.log('click Connect:', await clickText('Connect'))
  const connected = await waitBody('project', 20000) // empty-state or tab bar appears once connected
  console.log('connected UI state reached:', connected, '| body:', JSON.stringify((await body()).slice(0, 300)))
  await page.screenshot({ path: SHOTS + '/10-connected.png' })

  step('4. helper bootstrap status')
  let bs = null
  for (let i = 0; i < 20; i++) {
    bs = await page.evaluate((id) => window.api.bootstrapStatus(id), hostId)
    if (bs.helper.present) break
    await sleep(1500)
  }
  console.log('bootstrap:', JSON.stringify(bs))
  if (!bs.helper.present) throw new Error('helper never became present')

  step('5. add project via api, reopen UI')
  const project = await page.evaluate(([id, repo]) => window.api.projectAdd(id, 'e2e-demo', repo), [hostId, REPO])
  projectId = project.id
  cleanup.project = true
  console.log('project:', JSON.stringify(project))
  await page.reload()
  await sleep(1500)
  hookErrors(page)
  await clickText('Connect')
  await waitBody('e2e-demo', 15000)
  console.log('click project tab:', await clickText('e2e-demo'))
  await sleep(2500)
  await page.screenshot({ path: SHOTS + '/11-project-empty.png' })
  console.log('workspace:', JSON.stringify((await body()).slice(0, 400)))

  step('6. create worktree session (shell agent)')
  session = await page.evaluate(
    ([hid, pid]) =>
      window.api.sessionCreate(hid, pid, { agent: 'shell', mode: 'worktree', branch: 'e2e-branch' }),
    [hostId, projectId]
  )
  cleanup.session = true
  console.log('session:', JSON.stringify(session))
  const tmuxOk = execSync(`tmux has-session -t '=${session.tmuxName}' && echo LIVE`).toString().trim()
  console.log('tmux server-side:', tmuxOk)
  const wtOk = execSync(`git -C '${REPO}' worktree list | grep e2e-branch || true`).toString().trim()
  console.log('worktree server-side:', wtOk)

  step('7. reopen UI -> session panels attach')
  await page.reload()
  await sleep(1500)
  hookErrors(page)
  await clickText('Connect')
  await waitBody('e2e-demo', 15000)
  console.log('click project tab:', await clickText('e2e-demo'))
  await sleep(4000)
  await page.screenshot({ path: SHOTS + '/12-session-panels.png' })
  console.log('panels body:', JSON.stringify((await body()).slice(0, 500)))

  step('8. type into the terminal, verify on the tmux side')
  // click the xterm screen so the hidden textarea takes focus, then type for real
  const xtermBox = await page.evaluate(() => {
    const el = document.querySelector('.xterm-screen') || document.querySelector('.xterm')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + Math.min(40, r.height / 2) }
  })
  if (!xtermBox) throw new Error('no xterm element rendered')
  await page.mouse.click(xtermBox.x, xtermBox.y)
  await sleep(300)
  await page.keyboard.type('echo E2E_MARKER_$((6*7))', { delay: 25 })
  await page.keyboard.press('Enter')
  await sleep(2000)
  // capture the WHOLE pane: the prompt sits at the top, so tail() would miss it
  const pane = execSync(`tmux capture-pane -p -t "${session.tmuxName}:"`).toString()
  const paneLines = pane.split('\n').filter((l) => l.trim())
  console.log('tmux pane (non-empty lines):\n  ' + paneLines.join('\n  '))
  if (!pane.includes('E2E_MARKER_42')) throw new Error('terminal input did not reach tmux')
  console.log('>> keystrokes reached the real tmux session on the server')

  step('9. open a file from the tree')
  const clickedFile = await page.evaluate(() => {
    const leaf = [...document.querySelectorAll('*')].find(
      (e) => e.children.length === 0 && e.textContent && e.textContent.trim() === 'hello.py'
    )
    if (!leaf) return 'NOT_FOUND'
    // React delegates at the root, so a bubbling event hits the row's onClick
    leaf.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return 'OK'
  })
  console.log('click hello.py:', clickedFile)
  await sleep(4000)
  const viewer = await page.evaluate(() => {
    const lines = document.querySelector('.view-lines')
    if (lines) return 'MONACO: ' + lines.textContent.slice(0, 140)
    return 'NO_MONACO | body tail: ' + document.body.innerText.slice(-200)
  })
  console.log('viewer:', JSON.stringify(viewer))
  await page.screenshot({ path: SHOTS + '/13-file-open.png' })
  if (!viewer.startsWith('MONACO')) throw new Error('file did not open in the Monaco viewer')
  if (!viewer.includes('greet')) throw new Error('viewer shows the wrong file content')
  console.log('>> file opened with syntax-highlighted content')

  step('9b. markdown preview toggle')
  await page.evaluate(() => {
    const leaf = [...document.querySelectorAll('*')].find(
      (e) => e.children.length === 0 && e.textContent && e.textContent.trim() === 'README.md'
    )
    if (leaf) leaf.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await sleep(3000)
  const md = await page.evaluate(() => {
    const h1 = document.querySelector('.ra-md h1, .ra-md')
    return h1 ? 'RENDERED: ' + h1.textContent.slice(0, 80) : 'NO_PREVIEW'
  })
  console.log('markdown preview:', JSON.stringify(md))
  await page.screenshot({ path: SHOTS + '/14-markdown.png' })

  step('9c. settings tab reads real Claude Code config paths')
  const settingsRead = await page.evaluate(
    ([hid, repo]) =>
      Promise.all([
        window.api.settingsRead({ hostId: hid, scope: 'user', file: 'settings' }),
        window.api.codexWizardPreview({ hostId: hid, projectPath: repo })
      ]),
    [hostId, REPO]
  )
  console.log('user settings.json path:', settingsRead[0].path, '| exists:', settingsRead[0].exists)
  console.log(
    'codex wizard would write:',
    settingsRead[1].map((d) => d.path.replace(REPO, '<repo>')).join(', ')
  )
  if (!settingsRead[1].some((d) => d.path.endsWith('.mcp.json'))) {
    throw new Error('codex wizard did not plan an .mcp.json write')
  }
  const mcpDiff = settingsRead[1].find((d) => d.path.endsWith('.mcp.json'))
  console.log('  .mcp.json after:', mcpDiff.after.replace(/\s+/g, ' ').slice(0, 160))

  step('10. results')
  console.log('console errors:', errors.length ? errors.slice(0, 10) : 'none')
  console.log('E2E CORE FLOW OK')
} finally {
  step('cleanup')
  try {
    if (cleanup.session && session)
      await page.evaluate(
        ([hid, pid, sid]) => window.api.sessionKill(hid, pid, sid, { alsoRemoveWorktree: true }),
        [hostId, projectId, session.id]
      )
    if (cleanup.project)
      await page.evaluate(([hid, pid]) => window.api.projectRemove(hid, pid), [hostId, projectId])
    if (cleanup.host) await page.evaluate((hid) => window.api.hostsDelete(hid), hostId)
    console.log('cleanup done (session/project/host removed)')
  } catch (e) {
    console.log('cleanup issue:', e.message)
  }
  await app.close().catch(() => {})
}
