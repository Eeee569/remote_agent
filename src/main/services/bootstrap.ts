/**
 * Remote toolchain probing + installation. Probes python3/tmux/git/claude/
 * codex with one batched exec, checks the helper via its `version` call, and
 * installs targets (helper upload via sftp, claude/codex via streamed shell
 * installers) with line-by-line progress callbacks.
 */
import type {
  BootstrapProgressEvent,
  BootstrapStatus,
  InstallTarget,
  ToolStatus
} from '../../shared/domain'
import { HELPER_PATH, HELPER_TMUX_CONF } from '../../shared/helper-protocol'
import { getConnectionManager } from '../ssh/connection-manager'
import { execCommand, execStream } from '../ssh/exec'
import { getSftpService } from '../ssh/sftp-service'
import {
  HELPER_SOURCE,
  TMUX_CONF_SOURCE,
  getHelperClient,
  helperSha256,
  shQuote
} from './helper-client'

const PROBE_TIMEOUT_MS = 45_000

// ---------------- home dir ----------------

/** Absolute remote home directory, cached by the sftp service per connection. */
export async function remoteHome(hostId: string): Promise<string> {
  return getSftpService(hostId).homeDir()
}

// ---------------- status probing ----------------

const PROBE_TOOLS = [
  { key: 'python3', cmd: 'python3 --version' },
  { key: 'tmux', cmd: 'tmux -V' },
  { key: 'git', cmd: 'git --version' },
  { key: 'claude', cmd: 'claude --version' },
  { key: 'codex', cmd: 'codex --version' }
] as const

type ProbeKey = (typeof PROBE_TOOLS)[number]['key']

const MISSING_MARK = '__RA_MISSING__'

function buildProbeScript(): string {
  const lines = PROBE_TOOLS.map(({ key, cmd }) => {
    const bin = cmd.split(' ')[0]
    return `echo "==${key}"; command -v ${bin} >/dev/null 2>&1 && ${cmd} 2>&1 || echo ${MISSING_MARK}`
  })
  // extend PATH so user-local installs (claude/codex) are found from a
  // non-login shell, then run everything through POSIX sh
  const script =
    'PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/bin:$PATH"; export PATH; ' +
    lines.join('; ')
  return `sh -c ${shQuote(script)}`
}

function extractVersion(text: string): string | undefined {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0)
  if (!line) return undefined
  const m = line.match(/(\d+(?:\.\d+)+[A-Za-z0-9._-]*)/)
  return m ? m[1] : line
}

function parseProbeOutput(stdout: string): Record<ProbeKey, ToolStatus> {
  const sections = new Map<string, string[]>()
  let current: string[] | null = null
  for (const raw of stdout.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('==')) {
      current = []
      sections.set(line.slice(2).trim(), current)
    } else if (current) {
      current.push(line)
    }
  }
  const out = {} as Record<ProbeKey, ToolStatus>
  for (const { key } of PROBE_TOOLS) {
    const body = (sections.get(key) ?? []).join('\n')
    if (body.includes(MISSING_MARK) || body.trim().length === 0) {
      out[key] = { present: false }
    } else {
      const version = extractVersion(body)
      out[key] = { present: true, ...(version !== undefined ? { version } : {}) }
    }
  }
  return out
}

async function probeHelper(hostId: string): Promise<ToolStatus> {
  try {
    const v = await getHelperClient(hostId).version()
    return {
      present: true,
      version: v.version,
      upToDate: v.sha256 === helperSha256()
    }
  } catch {
    return { present: false }
  }
}

export async function bootstrapStatus(hostId: string): Promise<BootstrapStatus> {
  const client = getConnectionManager().getClient(hostId) // throws not-connected
  const [probeRes, helper] = await Promise.all([
    execCommand(client, buildProbeScript(), { timeoutMs: PROBE_TIMEOUT_MS }),
    probeHelper(hostId)
  ])
  const tools = parseProbeOutput(probeRes.stdout)
  return {
    python3: tools.python3,
    tmux: tools.tmux,
    git: tools.git,
    helper,
    claude: tools.claude,
    codex: tools.codex
  }
}

// ---------------- installation ----------------

const CLAUDE_INSTALL_CMD = 'curl -fsSL https://claude.ai/install.sh | bash'
const CLAUDE_NPM_FALLBACK_CMD = 'npm install -g @anthropic-ai/claude-code'
const CODEX_INSTALL_CMD = 'npm install -g @openai/codex'

type Progress = (e: BootstrapProgressEvent) => void

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function installHelper(hostId: string, emit: (line: string) => void): Promise<void> {
  const sftp = getSftpService(hostId)
  emit(`uploading helper to ${HELPER_PATH}`)
  await sftp.mkdirp('~/.remote-agent/bin')
  await sftp.writeFileAtomic(HELPER_PATH, Buffer.from(HELPER_SOURCE, 'utf8'), 0o755)
  emit(`uploading ${HELPER_TMUX_CONF}`)
  await sftp.writeFileAtomic(HELPER_TMUX_CONF, Buffer.from(TMUX_CONF_SOURCE, 'utf8'), 0o644)
  emit('initializing ~/.remote-agent')
  const v = await getHelperClient(hostId).init()
  emit(`helper ${v.version} installed`)
}

async function installViaShell(
  hostId: string,
  command: string,
  emit: (line: string) => void
): Promise<boolean> {
  const client = getConnectionManager().getClient(hostId)
  emit(`$ ${command}`)
  const res = await execStream(client, command, (line) => {
    if (line.trim().length > 0) emit(line)
  })
  return res.code === 0
}

async function installOne(hostId: string, target: InstallTarget, onProgress: Progress): Promise<boolean> {
  const emit = (line: string): void => onProgress({ hostId, target, line })
  try {
    let ok: boolean
    if (target === 'helper') {
      await installHelper(hostId, emit)
      ok = true
    } else if (target === 'claude') {
      ok = await installViaShell(hostId, CLAUDE_INSTALL_CMD, emit)
      if (!ok) {
        emit('installer failed; falling back to npm')
        ok = await installViaShell(hostId, CLAUDE_NPM_FALLBACK_CMD, emit)
      }
    } else {
      ok = await installViaShell(hostId, CODEX_INSTALL_CMD, emit)
    }
    onProgress({
      hostId,
      target,
      line: ok ? `${target} install complete` : `${target} install failed`,
      done: true,
      ok
    })
    return ok
  } catch (err) {
    onProgress({
      hostId,
      target,
      line: `${target} install failed: ${errText(err)}`,
      done: true,
      ok: false
    })
    return false
  }
}

/** Installs each target in order, streaming progress; never throws. */
export async function installTargets(
  hostId: string,
  targets: InstallTarget[],
  onProgress: Progress
): Promise<{ ok: boolean }> {
  let allOk = true
  for (const target of targets) {
    const ok = await installOne(hostId, target, onProgress)
    if (!ok) allOk = false
  }
  return { ok: allOk }
}

// ---------------- ensure helper (post-connect) ----------------

const ensuring = new Map<string, Promise<void>>()

/**
 * Called after each (re)connect: installs/updates the helper when its version
 * probe fails or the installed sha256 differs from the embedded source.
 * Concurrent calls per host are coalesced. Never throws.
 */
export function ensureHelper(hostId: string, onProgress?: Progress): Promise<void> {
  const inflight = ensuring.get(hostId)
  if (inflight) return inflight
  const p = (async () => {
    let stale: boolean
    try {
      const v = await getHelperClient(hostId).version()
      stale = v.sha256 !== helperSha256()
    } catch {
      stale = true
    }
    if (!stale) return
    await installTargets(hostId, ['helper'], onProgress ?? (() => undefined))
  })()
    .catch(() => undefined)
    .finally(() => {
      ensuring.delete(hostId)
    })
  ensuring.set(hostId, p)
  return p
}
