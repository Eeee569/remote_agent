/**
 * Typed client for the server-side helper (~/.remote-agent/bin/helper).
 * Every call is one `ssh exec` printing exactly one JSON envelope on stdout;
 * envelopes are validated with zod schemas from shared/helper-protocol.
 * Also embeds the helper + tmux.conf sources for upload by bootstrap.ts.
 */
import { createHash } from 'crypto'
import { z } from 'zod'
import helperSource from '../../../server-helper/helper.py?raw'
import tmuxConfSource from '../../../server-helper/tmux.conf?raw'
import type { AgentKind, GitStatus, TreeEntry, Worktree } from '../../shared/domain'
import {
  HELPER_PATH,
  HelperError,
  helperEnvelopeSchema,
  helperVersionSchema,
  gitStatusSchema,
  lsTreeSchema,
  okSchema,
  readStateSchema,
  sessionListSchema,
  worktreeAddSchema,
  worktreeListSchema,
  writeStateSchema,
  type HelperReadState,
  type HelperSessionList,
  type HelperVersion
} from '../../shared/helper-protocol'
import { getConnectionManager } from '../ssh/connection-manager'
import { execCommand } from '../ssh/exec'
import { CodedError } from '../util/errors'

export const HELPER_SOURCE: string = helperSource
export const TMUX_CONF_SOURCE: string = tmuxConfSource

let cachedSha: string | null = null

/** sha256 hex of the embedded helper source (matches `helper version` output). */
export function helperSha256(): string {
  if (!cachedSha) cachedSha = createHash('sha256').update(HELPER_SOURCE, 'utf8').digest('hex')
  return cachedSha
}

/** POSIX single-quote shell quoting; safe to embed in an exec command line. */
export function shQuote(s: string): string {
  if (s.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

const sessionCreateResultSchema = z.object({ tmuxName: z.string() })

function stderrTail(text: string, limit = 300): string {
  const t = text.trim()
  return t.length > limit ? '…' + t.slice(-limit) : t
}

const WORKTREE_TIMEOUT_MS = 120_000

export class HelperClient {
  constructor(private readonly hostId: string) {}

  private async run<S extends z.ZodTypeAny>(
    subcmd: string,
    args: string[],
    schema: S,
    opts?: { stdinJson?: unknown; timeoutMs?: number }
  ): Promise<z.output<S>> {
    const client = getConnectionManager().getClient(this.hostId) // throws not-connected
    const command = [HELPER_PATH, subcmd, ...args.map(shQuote)].join(' ')
    const res = await execCommand(client, command, {
      ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts?.stdinJson !== undefined ? { stdin: JSON.stringify(opts.stdinJson) } : {})
    })

    const invalid = (why: string): CodedError => {
      const tail = stderrTail(res.stderr)
      return new CodedError(
        'helper-invalid-output',
        `helper ${subcmd} ${why}` + (tail ? ` (stderr: ${tail})` : '')
      )
    }

    let json: unknown
    try {
      json = JSON.parse(res.stdout)
    } catch {
      throw invalid('produced no parseable JSON — is the helper installed?')
    }
    const env = helperEnvelopeSchema.safeParse(json)
    if (!env.success) throw invalid('produced an invalid envelope')
    if (!env.data.ok) throw new HelperError(env.data.error.code, env.data.error.message)
    const data = schema.safeParse(env.data.data)
    if (!data.success) throw invalid(`returned unexpected data: ${data.error.issues[0]?.message ?? 'schema mismatch'}`)
    return data.data
  }

  version(): Promise<HelperVersion> {
    return this.run('version', [], helperVersionSchema)
  }

  init(): Promise<HelperVersion> {
    return this.run('init', [], helperVersionSchema)
  }

  async lsTree(path: string, hidden?: boolean): Promise<TreeEntry[]> {
    const args = ['--path', path, ...(hidden ? ['--hidden'] : [])]
    return (await this.run('ls-tree', args, lsTreeSchema)).entries
  }

  gitStatus(path: string): Promise<GitStatus> {
    return this.run('git-status', ['--path', path], gitStatusSchema)
  }

  async sessionList(): Promise<HelperSessionList['sessions']> {
    return (await this.run('session-list', [], sessionListSchema)).sessions
  }

  async sessionCreate(opts: {
    name: string
    cwd: string
    agent: AgentKind
    cmd?: string
  }): Promise<{ tmuxName: string }> {
    const args = [
      '--name',
      opts.name,
      '--cwd',
      opts.cwd,
      '--agent',
      opts.agent,
      ...(opts.cmd !== undefined ? ['--cmd', opts.cmd] : [])
    ]
    return this.run('session-create', args, sessionCreateResultSchema)
  }

  async sessionKill(name: string): Promise<void> {
    await this.run('session-kill', ['--name', name], okSchema)
  }

  worktreeAdd(opts: {
    repo: string
    path: string
    branch: string
    base?: string
  }): Promise<{ path: string; branch: string }> {
    const args = [
      '--repo',
      opts.repo,
      '--path',
      opts.path,
      '--branch',
      opts.branch,
      ...(opts.base !== undefined ? ['--base', opts.base] : [])
    ]
    return this.run('worktree-add', args, worktreeAddSchema, { timeoutMs: WORKTREE_TIMEOUT_MS })
  }

  async worktreeList(repo: string): Promise<Worktree[]> {
    return (await this.run('worktree-list', ['--repo', repo], worktreeListSchema)).worktrees
  }

  async worktreeRemove(repo: string, path: string, force?: boolean): Promise<void> {
    const args = ['--repo', repo, '--path', path, ...(force ? ['--force'] : [])]
    await this.run('worktree-remove', args, okSchema, { timeoutMs: WORKTREE_TIMEOUT_MS })
  }

  readState(projectId?: string): Promise<HelperReadState> {
    const args = projectId !== undefined ? ['--project', projectId] : []
    return this.run('read-state', args, readStateSchema)
  }

  writeState(
    projectId: string | undefined,
    version: number,
    body: unknown
  ): Promise<{ version: number }> {
    const args = [
      ...(projectId !== undefined ? ['--project', projectId] : []),
      '--version',
      String(version),
      '--stdin-json'
    ]
    return this.run('write-state', args, writeStateSchema, { stdinJson: body })
  }
}

// ---------------- per-host singletons ----------------

const clients = new Map<string, HelperClient>()

export function getHelperClient(hostId: string): HelperClient {
  let c = clients.get(hostId)
  if (!c) {
    c = new HelperClient(hostId)
    clients.set(hostId, c)
  }
  return c
}
