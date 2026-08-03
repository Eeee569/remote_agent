// Codex-as-sub-agent E2E: apply the wizard through the real app, then ask the
// actual Claude Code CLI whether it picked up the MCP server. Also asserts that
// pre-existing user content in .mcp.json / settings.json survives the write.
//
// Env: E2E_SSH_PORT, E2E_KEY, E2E_REPO
import { _electron as electron } from 'playwright-core'
import { execSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const APP_DIR = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const PORT = Number(process.env.E2E_SSH_PORT || 2299)
const KEY = process.env.E2E_KEY
const REPO = process.env.E2E_REPO
if (!KEY || !REPO) {
  console.error('set E2E_KEY and E2E_REPO')
  process.exit(1)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const step = (n) => console.log('\n=== ' + n + ' ===')

const env = { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
delete env.ELECTRON_RUN_AS_NODE

// seed pre-existing content that MUST survive the wizard
const mcpPath = path.join(REPO, '.mcp.json')
const setPath = path.join(REPO, '.claude/settings.json')
fs.mkdirSync(path.dirname(setPath), { recursive: true })
fs.writeFileSync(
  mcpPath,
  JSON.stringify({ mcpServers: { 'my-existing': { type: 'stdio', command: 'echo', args: ['hi'] } } }, null, 2)
)
fs.writeFileSync(
  setPath,
  JSON.stringify({ model: 'sonnet', someUnknownKeyUsersRelyOn: { deep: [1, 2, 3] }, permissions: { deny: ['Read(./.env)'] } }, null, 2)
)
console.log('seeded pre-existing .mcp.json and .claude/settings.json')

const app = await electron.launch({
  executablePath: APP_DIR + '/node_modules/electron/dist/electron',
  args: ['--no-sandbox', APP_DIR],
  env,
  timeout: 30_000
})
const page = await app.firstWindow()
await page.waitForLoadState('domcontentloaded')
await sleep(2200)

let hostId = ''
try {
  const host = await page.evaluate(
    ([port, key]) =>
      window.api.hostsSave({ label: 'e2e-codex', host: '127.0.0.1', port, username: 'will', authKind: 'key', keyPath: key }),
    [PORT, KEY]
  )
  hostId = host.id
  await page.evaluate((id) => window.api.connConnect(id), hostId)

  step('1. preview (nothing written yet)')
  const diffs = await page.evaluate(
    ([hid, repo]) => window.api.codexWizardPreview({ hostId: hid, projectPath: repo }),
    [hostId, REPO]
  )
  console.log('files planned:', diffs.map((d) => path.basename(d.path)).join(', '))
  const onDiskBefore = fs.readFileSync(mcpPath, 'utf8')
  if (!onDiskBefore.includes('my-existing') || onDiskBefore.includes('codex')) {
    throw new Error('preview must not write anything')
  }
  console.log('>> preview is read-only, existing file untouched')

  step('2. apply')
  const applied = await page.evaluate(
    ([hid, repo]) => window.api.codexWizardApply({ hostId: hid, projectPath: repo }),
    [hostId, REPO]
  )
  console.log('written:', applied.filesChanged.map((p) => p.replace(REPO, '<repo>')).join(', '))

  step('3. existing user content preserved?')
  const mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'))
  const set = JSON.parse(fs.readFileSync(setPath, 'utf8'))
  console.log('mcpServers keys:', Object.keys(mcp.mcpServers).join(', '))
  console.log('codex entry:', JSON.stringify(mcp.mcpServers.codex))
  console.log('settings keys:', Object.keys(set).join(', '))
  console.log('unknown key intact:', JSON.stringify(set.someUnknownKeyUsersRelyOn))
  console.log('pre-existing deny rule intact:', JSON.stringify(set.permissions?.deny))
  console.log('allow now:', JSON.stringify(set.permissions?.allow))
  console.log('enabledMcpjsonServers:', JSON.stringify(set.enabledMcpjsonServers))
  if (!mcp.mcpServers['my-existing']) throw new Error('DATA LOSS: existing MCP server dropped')
  if (!set.someUnknownKeyUsersRelyOn) throw new Error('DATA LOSS: unknown settings key dropped')
  if (!set.permissions?.deny?.includes('Read(./.env)')) throw new Error('DATA LOSS: deny rule dropped')
  if (set.model !== 'sonnet') throw new Error('DATA LOSS: model overwritten')
  console.log('>> all pre-existing content preserved')

  step('4. agent file')
  const agentMd = fs.readFileSync(path.join(REPO, '.claude/agents/codex-worker.md'), 'utf8')
  console.log('agent frontmatter:\n  ' + agentMd.split('\n').slice(0, 8).join('\n  '))
  if (!agentMd.includes('mcp__codex__codex')) throw new Error('agent file does not reference the codex tools')

  step('5. does the REAL Claude Code CLI see it?')
  const out = execSync(`cd ${REPO} && claude mcp list 2>&1 || true`, { shell: '/bin/bash', timeout: 90_000 }).toString()
  console.log(out.trim().split('\n').slice(0, 12).map((l) => '  ' + l).join('\n'))
  if (!/codex/i.test(out)) throw new Error('claude mcp list does not show the codex server')
  console.log('>> Claude Code recognises the Codex MCP server written by the wizard')

  console.log('\nCODEX WIZARD E2E OK')
} finally {
  try {
    if (hostId) await page.evaluate((h) => window.api.hostsDelete(h), hostId)
  } catch {}
  await app.close().catch(() => {})
}
