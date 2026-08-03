// Resilience E2E: the core promise of Remote Agent — tmux on the server is the
// source of truth, so agents keep running when the GUI or the network goes away.
//
// 1. create a session, start a long-running counter in it
// 2. QUIT the app entirely, relaunch -> session still running, output preserved, reattached
// 3. DROP the SSH connection (kill sshd's child) -> auto-reconnect, terminal reattaches,
//    the counter kept advancing the whole time
//
// Env: E2E_SSH_PORT, E2E_KEY, E2E_REPO
import { _electron as electron } from 'playwright-core'
import { execSync } from 'node:child_process'
import * as fs from 'node:fs'

const APP_DIR = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const SHOTS = process.env.SCREENSHOT_DIR || '/tmp/ra-e2e-shots'
const PORT = Number(process.env.E2E_SSH_PORT || 2299)
const KEY = process.env.E2E_KEY
const REPO = process.env.E2E_REPO
const SSHD_DIR = process.env.E2E_SSHD_DIR
if (!KEY || !REPO || !SSHD_DIR) {
  console.error('set E2E_KEY, E2E_REPO and E2E_SSHD_DIR')
  process.exit(1)
}
fs.mkdirSync(SHOTS, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (n) => console.log('\n=== ' + n + ' ===')
const sh = (c) => execSync(c, { shell: '/bin/bash' }).toString().trim()

const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
delete env.ELECTRON_RUN_AS_NODE

async function launch() {
  const app = await electron.launch({
    executablePath: APP_DIR + '/node_modules/electron/dist/electron',
    args: ['--no-sandbox', APP_DIR],
    env,
    timeout: 30_000
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await sleep(2200)
  return { app, page }
}

const body = (page) => page.evaluate(() => document.body.innerText)
const clickText = (page, t) =>
  page.evaluate((txt) => {
    const buttons = [...document.querySelectorAll('button')]
    const btn =
      buttons.find((e) => e.textContent?.trim() === txt) ??
      buttons.find((e) => e.textContent?.includes(txt))
    if (btn) {
      btn.click()
      return 'OK<BUTTON>'
    }
    const leaf = [...document.querySelectorAll('*')].find(
      (e) => e.children.length === 0 && e.textContent?.trim() === txt
    )
    if (!leaf) return 'NOT_FOUND'
    leaf.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    return 'OK'
  }, t)
const waitBody = async (page, txt, ms = 20000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if ((await body(page)).includes(txt)) return true
    await sleep(400)
  }
  return false
}

let hostId = ''
let projectId = ''
let session = null
let cur = null

try {
  step('setup: host + project + session with a live counter')
  cur = await launch()
  const host = await cur.page.evaluate(
    ([port, key]) =>
      window.api.hostsSave({
        label: 'e2e-resil',
        host: '127.0.0.1',
        port,
        username: 'will',
        authKind: 'key',
        keyPath: key
      }),
    [PORT, KEY]
  )
  hostId = host.id
  await cur.page.evaluate((id) => window.api.connConnect(id), hostId)
  const project = await cur.page.evaluate(
    ([id, repo]) => window.api.projectAdd(id, 'resil-demo', repo),
    [hostId, REPO]
  )
  projectId = project.id
  session = await cur.page.evaluate(
    ([hid, pid]) =>
      window.api.sessionCreate(hid, pid, { agent: 'shell', mode: 'worktree', branch: 'resil-branch' }),
    [hostId, projectId]
  )
  console.log('session:', session.tmuxName, '| cwd:', session.cwd)

  // start a counter that appends to a file every second — survives detach
  const marker = '/tmp/ra-resil-counter.txt'
  sh(`rm -f ${marker}`)
  sh(
    `tmux send-keys -t "${session.tmuxName}:" ` +
      `'i=0; while true; do i=$((i+1)); echo "tick $i" >> ${marker}; sleep 1; done' Enter`
  )
  await sleep(3500)
  const ticksBefore = Number(sh(`wc -l < ${marker}`))
  console.log('counter running, ticks so far:', ticksBefore)
  if (ticksBefore < 2) throw new Error('counter did not start')

  step('1. QUIT the app entirely (simulates closing the laptop lid / app crash)')
  await cur.app.close()
  cur = null
  await sleep(4000)
  const ticksWhileClosed = Number(sh(`wc -l < ${marker}`))
  console.log('ticks while the app was CLOSED:', ticksWhileClosed, '(was', ticksBefore + ')')
  if (ticksWhileClosed <= ticksBefore) throw new Error('work stopped when the app closed')
  console.log('>> the agent session kept running with no GUI attached')

  step('2. relaunch -> reconnect -> session restored from server state')
  cur = await launch()
  console.log('click Connect:', await clickText(cur.page, 'Connect'))
  const sawProject = await waitBody(cur.page, 'resil-demo', 25000)
  console.log('project tab restored:', sawProject)
  console.log('click project tab:', await clickText(cur.page, 'resil-demo'))
  await sleep(5000)
  const restored = await body(cur.page)
  console.log('workspace after relaunch:', JSON.stringify(restored.slice(0, 320)))
  if (!restored.includes(session.tmuxName)) throw new Error('session panel not restored after relaunch')
  await cur.page.screenshot({ path: SHOTS + '/20-after-relaunch.png' })

  // the reattached terminal should be showing the still-running counter's session
  const paneAfter = sh(`tmux capture-pane -p -t "${session.tmuxName}:"`)
  console.log('tmux pane still alive:', paneAfter.split('\n').filter((l) => l.trim()).length, 'lines')
  console.log('>> layout + session restored from server state, terminal reattached')

  step('3. DROP the SSH connection mid-session (network failure)')
  const ticksBeforeDrop = Number(sh(`wc -l < ${marker}`))
  // Kill the sshd *connection children* only, leaving the listener up so the app can
  // reconnect and the tmux server untouched. Matching on comm (-x sshd) avoids the
  // classic pgrep self-match; the listener pid comes from sshd.pid.
  // OpenSSH >= 9.8 runs connections as `sshd-session` under a privileged parent, and
  // the *unprivileged grandchild* holds the socket — so kill the whole descendant tree
  // of our listener (never the system sshd), leaving the listener up to accept the
  // reconnect. Verified by watching the ESTABLISHED socket count go to zero.
  const listenerPid = sh(`cat ${SSHD_DIR}/sshd.pid`).trim()
  const before = Number(sh(`ss -tn | grep -c ':${PORT}' || true`))
  const tree = (pid) =>
    sh(`pgrep -P ${pid} || true`)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .flatMap((p) => [...tree(p), p])
  const victims = [...new Set(tree(listenerPid))]
  console.log('listener pid:', listenerPid, '| connection tree:', JSON.stringify(victims))
  if (!victims.length) throw new Error('no live sshd connection to drop — cannot test reconnect')

  // Record the app's own connection events from *before* the kill: the app can
  // reconnect in well under a second, so polling socket counts afterwards races it.
  await cur.page.evaluate(() => {
    window.__raEvents = []
    window.api.onConn((e) => window.__raEvents.push(e.status))
  })
  sh(`kill -9 ${victims.join(' ')} 2>/dev/null || true`)
  const survivors = sh(`ps -p ${victims.join(',')} -o pid= || true`).trim()
  if (survivors) throw new Error('sshd connection processes survived: ' + survivors)
  if (!sh(`ps -p ${listenerPid} -o pid= || true`).trim()) throw new Error('listener died too')
  console.log('ESTABLISHED sockets before kill:', before, '| connection processes killed, listener up')
  console.log('>> SSH connection forcibly killed')
  await sleep(1500)
  const duringDrop = await body(cur.page)
  console.log(
    'UI during drop:',
    JSON.stringify(duringDrop.slice(0, 200)),
    '| shows reconnect state:',
    /reconnect|Reconnect|lost|Disconnected|failed/i.test(duringDrop)
  )
  await cur.page.screenshot({ path: SHOTS + '/21-connection-dropped.png' })

  step('4. auto-reconnect + verify no work was lost')
  // require an observed departure from 'connected' before accepting the recovery,
  // otherwise a no-op drop would trivially "pass"
  let events = []
  let reconnected = false
  for (let i = 0; i < 150; i++) {
    events = await cur.page.evaluate(() => window.__raEvents || [])
    const dropped = events.some((s) => s !== 'connected')
    if (dropped && events[events.length - 1] === 'connected') {
      reconnected = true
      break
    }
    await sleep(400)
  }
  const status = await cur.page.evaluate((id) => window.api.connStatus(id), hostId)
  console.log('conn events emitted by the app:', JSON.stringify(events), '| final status:', status)
  console.log('auto-reconnected after an observed drop:', reconnected)
  if (!reconnected) throw new Error('never observed a drop -> reconnect cycle: ' + events.join(','))
  const ticksAfter = Number(sh(`wc -l < ${marker}`))
  console.log('ticks before drop:', ticksBeforeDrop, '-> after reconnect:', ticksAfter)
  if (ticksAfter <= ticksBeforeDrop) throw new Error('counter stopped across the disconnect')
  console.log('>> work continued uninterrupted through the network failure')

  // terminal should be usable again
  await sleep(3000)
  await cur.page.screenshot({ path: SHOTS + '/22-after-reconnect.png' })
  const sessions = await cur.page.evaluate(
    ([hid, pid]) => window.api.sessionList(hid, pid),
    [hostId, projectId]
  )
  console.log('sessionList after reconnect:', JSON.stringify(sessions.map((s) => ({ n: s.tmuxName, alive: s.alive }))))
  if (!sessions.some((s) => s.tmuxName === session.tmuxName && s.alive)) {
    throw new Error('session not reported alive after reconnect')
  }

  console.log('\nRESILIENCE E2E OK')
} finally {
  step('cleanup')
  try {
    sh(`tmux kill-session -t "=${session?.tmuxName}" 2>/dev/null || true`)
    sh(`rm -f /tmp/ra-resil-counter.txt`)
    if (cur && projectId) {
      await cur.page
        .evaluate(
          ([hid, pid, sid]) => window.api.sessionKill(hid, pid, sid, { alsoRemoveWorktree: true }),
          [hostId, projectId, session?.id]
        )
        .catch(() => {})
      await cur.page.evaluate(([hid, pid]) => window.api.projectRemove(hid, pid), [hostId, projectId]).catch(() => {})
      await cur.page.evaluate((hid) => window.api.hostsDelete(hid), hostId).catch(() => {})
    }
    console.log('cleanup done')
  } catch (e) {
    console.log('cleanup issue:', e.message)
  }
  if (cur) await cur.app.close().catch(() => {})
}
