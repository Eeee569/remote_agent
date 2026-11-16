/**
 * Everything the phone asks of a host, over `ssh exec`: the server helper
 * (~/.remote-agent/bin/helper) and the project/session state it persists.
 *
 * This is the phone-side twin of src/main/services/{helper-client,state,
 * bootstrap}.ts and must stay compatible with them — both clients read and
 * write the same state files, so a session made on the phone shows up on the
 * desktop and the other way round.
 */
import helperSource from '../../../server-helper/helper.py?raw'
import tmuxConfSource from '../../../server-helper/tmux.conf?raw'
import type {
  AgentKind,
  ProjectLayout,
  ProjectMeta,
  SessionMeta,
  SessionSpec,
  TreeEntry
} from '@shared/domain'
import { HELPER_PATH, HELPER_TMUX_CONF, shellTmuxName } from '@shared/helper-protocol'
import { shQuote } from '../../../src/main/util/sh'
import { buildAttachCommand, slug, suggestTmuxName } from '../../../src/main/services/tmux'
import { base64ToBytes, bytesToBase64, call, NativeError } from './native'

export { buildAttachCommand, shellTmuxName }

export class RemoteError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'RemoteError'
  }
}

interface ExecResult {
  stdout: string
  stderr: string
  code: number
  truncated: boolean
}

interface ProjectStateBody {
  project: ProjectMeta
  sessions: SessionMeta[]
  layout: ProjectLayout
  updatedAt: number
}

interface IndexState {
  projects: ProjectMeta[]
}

interface LiveSession {
  tmuxName: string
  attachedClients: number
}

const SLOW_GIT_TIMEOUT_MS = 120_000
/** sshd caps channels per connection (MaxSessions, default 10); terminals hold some */
const MAX_PARALLEL_EXEC = 3
const HEREDOC = 'RA_EOF_5d0c1b7e'
export const MAX_VIEW_BYTES = 400_000
/**
 * sshd hands the whole command to the login shell as one argument, which Linux
 * caps at 128 KiB — so a file is sent in pieces this many bytes long (base64
 * makes each a third larger).
 */
const WRITE_CHUNK_BYTES = 48_000

/**
 * Reads and writes one file for the editor. It runs as `python3 -c` rather
 * than as a helper subcommand because the phone never replaces a helper the
 * desktop installed, so it cannot count on that helper having new commands.
 * python3 is already required by the helper. The script deliberately contains
 * no single quotes or backslashes, so every login shell passes it through
 * unchanged.
 *
 *   read PATH LIMIT              -> size, truncated, sha, writable, b64
 *   put PATH NONCE INDEX B64     appends a piece to a temp file beside PATH
 *   commit PATH NONCE LEN SHA FORCE
 *                                checks the pieces add up to LEN and that PATH
 *                                still has content SHA (unless FORCE), then
 *                                renames the temp file over PATH
 *   abort PATH NONCE             removes the temp file
 */
const FILE_SCRIPT = `
import sys, os, json, base64, hashlib, stat

def out(obj):
    sys.stdout.write(json.dumps(obj))

def fail(code, message):
    out({"ok": False, "code": code, "message": message})

def sha_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            block = f.read(1 << 20)
            if not block:
                break
            h.update(block)
    return h.hexdigest()

def tmp_for(real, nonce):
    if not nonce.isalnum():
        raise ValueError("bad nonce")
    return os.path.join(os.path.dirname(real), "." + os.path.basename(real) + "." + nonce + ".ra-tmp")

def main():
    op = sys.argv[1]
    real = os.path.realpath(os.path.expanduser(sys.argv[2]))
    if op == "read":
        limit = int(sys.argv[3])
        st = os.stat(real)
        if not stat.S_ISREG(st.st_mode):
            return fail("not-a-file", "not a regular file")
        with open(real, "rb") as f:
            data = f.read(limit + 1)
        truncated = len(data) > limit
        data = data[:limit]
        writable = os.access(real, os.W_OK) and os.access(os.path.dirname(real), os.W_OK)
        return out({"ok": True, "size": st.st_size, "truncated": truncated,
                    "sha": hashlib.sha256(data).hexdigest(), "writable": writable,
                    "b64": base64.b64encode(data).decode("ascii")})
    tmp = tmp_for(real, sys.argv[3])
    if op == "put":
        data = b"" if sys.argv[5] == "-" else base64.b64decode(sys.argv[5])
        if int(sys.argv[4]) == 0:
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        else:
            fd = os.open(tmp, os.O_WRONLY | os.O_APPEND)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        return out({"ok": True})
    if op == "abort":
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        return out({"ok": True})
    if op == "commit":
        length, expected, force = int(sys.argv[4]), sys.argv[5], sys.argv[6] == "1"
        if os.path.getsize(tmp) != length:
            return fail("io-error", "the file did not arrive complete")
        try:
            st = os.stat(real)
        except FileNotFoundError:
            st = None
        if st is not None and not stat.S_ISREG(st.st_mode):
            return fail("not-a-file", "not a regular file")
        if not force:
            if st is None:
                return fail("conflict", "deleted")
            if sha_of(real) != expected:
                return fail("conflict", "changed")
        os.chmod(tmp, stat.S_IMODE(st.st_mode) if st is not None else 0o644)
        with open(tmp, "rb") as f:
            os.fsync(f.fileno())
        new_sha = sha_of(tmp)
        os.replace(tmp, real)
        return out({"ok": True, "sha": new_sha, "size": length})
    fail("bad-args", "unknown operation")

try:
    main()
except OSError as e:
    fail("io-error", e.strerror or str(e))
except Exception as e:
    fail("internal", str(e))
`

export interface RemoteFile {
  bytes: Uint8Array
  /** size on disk, which is more than `bytes` when `truncated` */
  size: number
  truncated: boolean
  /** hash of the content, handed back on save to detect a change in between */
  sha: string
  writable: boolean
}

function newId(prefix: string): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function defaultLayout(): ProjectLayout {
  return { dockview: null, openFilesBySession: {}, schemaVersion: 1 }
}

function basename(path: string): string {
  const parts = path.split('/').filter((p) => p !== '')
  return parts[parts.length - 1] ?? ''
}

/** `cmd` with `stdin` fed through a quoted heredoc — works under any login shell. */
function withStdin(cmd: string, stdin: string): string {
  const body = stdin.endsWith('\n') ? stdin.slice(0, -1) : stdin
  return `sh -c ${shQuote(`{ ${cmd}; } <<'${HEREDOC}'\n${body}\n${HEREDOC}`)}`
}

export class Remote {
  private active = 0
  private readonly waiting: Array<() => void> = []
  private home: string | null = null

  constructor(public readonly connId: string) {}

  // ---------------- exec ----------------

  async exec(command: string, opts: { stdin?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
    if (this.active >= MAX_PARALLEL_EXEC) {
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    this.active++
    try {
      return await call<ExecResult>('ssh.exec', {
        connId: this.connId,
        command: opts.stdin !== undefined ? withStdin(command, opts.stdin) : command,
        timeoutMs: opts.timeoutMs ?? 30_000
      })
    } catch (err) {
      if (err instanceof NativeError) throw new RemoteError(err.code, err.message)
      throw err
    } finally {
      this.active--
      this.waiting.shift()?.()
    }
  }

  private async helper<T>(
    subcmd: string,
    args: string[],
    opts: { stdinJson?: unknown; timeoutMs?: number } = {}
  ): Promise<T> {
    const command = [HELPER_PATH, subcmd, ...args.map(shQuote)].join(' ')
    const res = await this.exec(command, {
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
      ...(opts.stdinJson !== undefined ? { stdin: JSON.stringify(opts.stdinJson) } : {})
    })
    let env: { ok?: boolean; data?: unknown; error?: { code: string; message: string } }
    try {
      env = JSON.parse(res.stdout)
    } catch {
      const tail = res.stderr.trim().slice(-200)
      throw new RemoteError(
        'helper-invalid-output',
        `helper ${subcmd} produced no parseable output` + (tail ? ` (${tail})` : '')
      )
    }
    if (env.ok !== true) {
      throw new RemoteError(env.error?.code ?? 'internal', env.error?.message ?? 'helper failed')
    }
    return env.data as T
  }

  // ---------------- bootstrap ----------------

  /**
   * Makes sure the server helper exists. The phone only ever installs a
   * missing helper: an existing one is left alone even when it differs from
   * the copy bundled here, because the desktop app keeps it in step with *its*
   * bundle and two clients of different ages would otherwise keep replacing
   * each other's helper on every connect.
   */
  async ensureHelper(): Promise<void> {
    try {
      await this.helper('version', [])
      return
    } catch (err) {
      if (err instanceof RemoteError && (err.code === 'not-connected' || err.code === 'timeout')) {
        throw err
      }
    }
    const probe = await this.exec('command -v python3 >/dev/null 2>&1 && echo yes || echo no')
    if (!probe.stdout.includes('yes')) {
      throw new RemoteError('python-missing', 'python3 is not installed on this host')
    }
    const dir = '~/.remote-agent/bin'
    const install = await this.exec(
      `mkdir -p ${dir} && cat > ${HELPER_PATH}.tmp && chmod 755 ${HELPER_PATH}.tmp && mv ${HELPER_PATH}.tmp ${HELPER_PATH}`,
      { stdin: helperSource }
    )
    if (install.code !== 0) {
      throw new RemoteError('io-error', `could not install the helper: ${install.stderr.trim()}`)
    }
    await this.exec(`test -e ${HELPER_TMUX_CONF} || cat > ${HELPER_TMUX_CONF}`, {
      stdin: tmuxConfSource
    })
    await this.helper('init', [])
  }

  async homeDir(): Promise<string> {
    if (this.home === null) {
      const res = await this.exec('printf %s "$HOME"')
      this.home = res.stdout.trim()
    }
    return this.home
  }

  // ---------------- state ----------------

  private readState<T>(projectId?: string): Promise<{ version: number; state: T | null }> {
    return this.helper('read-state', projectId !== undefined ? ['--project', projectId] : [])
  }

  private async mutateState<T>(
    projectId: string | undefined,
    mutate: (cur: T | null) => T,
    attempts = 3
  ): Promise<T> {
    let lastErr: unknown = null
    for (let i = 0; i < attempts; i++) {
      const { version, state } = await this.readState<T>(projectId)
      const next = mutate(state ?? null)
      try {
        await this.helper(
          'write-state',
          [
            ...(projectId !== undefined ? ['--project', projectId] : []),
            '--version',
            String(version),
            '--stdin-json'
          ],
          { stdinJson: next }
        )
        return next
      } catch (err) {
        if (err instanceof RemoteError && err.code === 'conflict' && i < attempts - 1) {
          lastErr = err
          continue
        }
        throw err
      }
    }
    throw lastErr instanceof Error ? lastErr : new RemoteError('conflict', 'state write kept conflicting')
  }

  // ---------------- projects ----------------

  async projectList(): Promise<ProjectMeta[]> {
    const { state } = await this.readState<IndexState>()
    return state?.projects ?? []
  }

  async projectAdd(name: string, repoPath: string): Promise<ProjectMeta> {
    const init = await this.helper<{ path: string }>('git-init', ['--path', repoPath], {
      timeoutMs: SLOW_GIT_TIMEOUT_MS
    })
    const meta: ProjectMeta = { id: newId('p_'), name, repoPath: init.path, createdAt: Date.now() }
    await this.mutateState<IndexState>(undefined, (cur) => ({
      projects: [...(cur?.projects ?? []), meta]
    }))
    return meta
  }

  /** Removes the project from the index only; server files are never deleted. */
  async projectRemove(projectId: string): Promise<void> {
    await this.mutateState<IndexState>(undefined, (cur) => ({
      projects: (cur?.projects ?? []).filter((p) => p.id !== projectId)
    }))
  }

  // ---------------- sessions ----------------

  private async liveSessions(): Promise<LiveSession[]> {
    return (await this.helper<{ sessions: LiveSession[] }>('session-list', [])).sessions
  }

  /** Every project with its sessions, joined with what tmux says is running. */
  async overview(): Promise<{ projects: ProjectMeta[]; sessions: Record<string, SessionMeta[]> }> {
    const [projects, live] = await Promise.all([this.projectList(), this.liveSessions()])
    const liveByName = new Map(live.map((s) => [s.tmuxName, s]))
    const sessions: Record<string, SessionMeta[]> = {}
    await Promise.all(
      projects.map(async (p) => {
        const { state } = await this.readState<ProjectStateBody>(p.id)
        sessions[p.id] = (state?.sessions ?? []).map((s) => {
          const t = liveByName.get(s.tmuxName)
          return { ...s, alive: t !== undefined, attachedClients: t?.attachedClients ?? 0 }
        })
      })
    )
    return { projects, sessions }
  }

  async sessionCreate(project: ProjectMeta, spec: SessionSpec): Promise<SessionMeta> {
    let cwd: string
    let worktree: SessionMeta['worktree']
    if (spec.mode === 'worktree') {
      if (!spec.branch) throw new RemoteError('bad-args', 'a branch name is required')
      const home = await this.homeDir()
      const path = `${home}/.remote-agent/worktrees/${project.id}/${slug(spec.branch)}`
      const added = await this.helper<{ path: string; branch: string }>(
        'worktree-add',
        [
          '--repo',
          project.repoPath,
          '--path',
          path,
          '--branch',
          spec.branch,
          ...(spec.baseRef !== undefined ? ['--base', spec.baseRef] : [])
        ],
        { timeoutMs: SLOW_GIT_TIMEOUT_MS }
      )
      cwd = added.path
      worktree = {
        path: added.path,
        branch: added.branch,
        ...(spec.baseRef !== undefined ? { baseRef: spec.baseRef } : {})
      }
    } else {
      if (!spec.dir) throw new RemoteError('bad-args', 'a directory is required')
      cwd = spec.dir
    }

    const hint = spec.branch || basename(cwd) || 'session'
    const base = spec.tmuxName || suggestTmuxName(project.name, hint)
    const [{ state }, live] = await Promise.all([
      this.readState<ProjectStateBody>(project.id),
      this.liveSessions()
    ])
    const taken = new Set<string>(live.map((s) => s.tmuxName))
    for (const s of state?.sessions ?? []) taken.add(s.tmuxName)
    let tmuxName = base
    for (let n = 2; taken.has(tmuxName); n++) tmuxName = `${base}-${n}`

    const launchCmd =
      spec.launchCommand ||
      (spec.agent === 'claude' ? 'claude' : spec.agent === 'codex' ? 'codex' : undefined)
    await this.helper('session-create', [
      '--name',
      tmuxName,
      '--cwd',
      cwd,
      '--agent',
      spec.agent,
      ...(launchCmd !== undefined ? ['--cmd', launchCmd] : [])
    ])

    const meta: SessionMeta = {
      id: newId('s_'),
      projectId: project.id,
      tmuxName,
      agent: spec.agent,
      mode: spec.mode,
      cwd,
      ...(worktree !== undefined ? { worktree } : {}),
      createdAt: Date.now(),
      createdBy: 'iphone'
    }
    await this.mutateState<ProjectStateBody>(project.id, (cur) => ({
      project: cur?.project ?? project,
      sessions: [...(cur?.sessions ?? []), meta],
      layout: cur?.layout ?? defaultLayout(),
      updatedAt: Date.now()
    }))
    return { ...meta, alive: true, attachedClients: 0 }
  }

  async sessionKill(project: ProjectMeta, session: SessionMeta, alsoRemoveWorktree: boolean): Promise<void> {
    try {
      await this.helper('session-kill', ['--name', session.tmuxName])
    } catch (err) {
      if (!(err instanceof RemoteError && err.code === 'session-missing')) throw err
    }
    try {
      await this.helper('session-kill', ['--name', shellTmuxName(session.tmuxName)])
    } catch {
      // the companion shell is created lazily and often does not exist
    }
    if (alsoRemoveWorktree && session.mode === 'worktree' && session.worktree) {
      await this.helper(
        'worktree-remove',
        ['--repo', project.repoPath, '--path', session.worktree.path, '--force'],
        { timeoutMs: SLOW_GIT_TIMEOUT_MS }
      )
    }
    await this.mutateState<ProjectStateBody>(project.id, (cur) => ({
      project: cur?.project ?? project,
      sessions: (cur?.sessions ?? []).filter((s) => s.id !== session.id),
      layout: cur?.layout ?? defaultLayout(),
      updatedAt: Date.now()
    }))
  }

  // ---------------- files ----------------

  async lsTree(path: string, hidden: boolean): Promise<TreeEntry[]> {
    const args = ['--path', path, ...(hidden ? ['--hidden'] : [])]
    return (await this.helper<{ entries: TreeEntry[] }>('ls-tree', args)).entries
  }

  private async fileOp<T>(args: string[]): Promise<T> {
    const res = await this.exec(['python3', '-c', shQuote(FILE_SCRIPT), ...args.map(shQuote)].join(' '))
    let env: { ok?: boolean; code?: string; message?: string }
    try {
      env = JSON.parse(res.stdout)
    } catch {
      throw new RemoteError('io-error', res.stderr.trim().slice(-200) || 'the host gave no answer')
    }
    if (env.ok !== true) throw new RemoteError(env.code ?? 'internal', env.message ?? 'failed')
    return env as T
  }

  /** The first MAX_VIEW_BYTES of a file, byte for byte. */
  async readFile(path: string): Promise<RemoteFile> {
    const r = await this.fileOp<Omit<RemoteFile, 'bytes'> & { b64: string }>([
      'read',
      path,
      String(MAX_VIEW_BYTES)
    ])
    return {
      bytes: base64ToBytes(r.b64),
      size: r.size,
      truncated: r.truncated,
      sha: r.sha,
      writable: r.writable
    }
  }

  /**
   * Replaces a file's content atomically, keeping its permissions. Unless
   * `force`, fails with code `conflict` when the file no longer has the
   * content `expectedSha` describes (message `changed` or `deleted`).
   */
  async writeFile(
    path: string,
    bytes: Uint8Array,
    expectedSha: string,
    force = false
  ): Promise<{ sha: string; size: number }> {
    const nonce = newId('e')
    try {
      for (let offset = 0, index = 0; index === 0 || offset < bytes.length; index++) {
        const piece = bytes.subarray(offset, offset + WRITE_CHUNK_BYTES)
        offset += piece.length
        await this.fileOp(['put', path, nonce, String(index), piece.length > 0 ? bytesToBase64(piece) : '-'])
      }
      return await this.fileOp<{ sha: string; size: number }>([
        'commit',
        path,
        nonce,
        String(bytes.length),
        expectedSha,
        force ? '1' : '0'
      ])
    } catch (err) {
      await this.fileOp(['abort', path, nonce]).catch(() => undefined)
      throw err
    }
  }

  /** The last screens of a tmux pane as plain text, for select-and-copy. */
  async capturePane(tmuxName: string): Promise<string> {
    const res = await this.exec(`tmux capture-pane -p -J -S -400 -t ${shQuote('=' + tmuxName + ':')}`)
    if (res.code !== 0) {
      throw new RemoteError('tmux-failed', res.stderr.trim() || 'could not read the pane')
    }
    return res.stdout.replace(/\s+$/, '') + '\n'
  }

  /** Appends a public key to ~/.ssh/authorized_keys unless it is already there. */
  async installPublicKey(publicKey: string): Promise<void> {
    const key = shQuote(publicKey)
    const res = await this.exec(
      'sh -c ' +
        shQuote(
          'umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && ' +
            `(grep -qxF ${key} ~/.ssh/authorized_keys || printf '%s\\n' ${key} >> ~/.ssh/authorized_keys)`
        )
    )
    if (res.code !== 0) {
      throw new RemoteError('io-error', res.stderr.trim() || 'could not write authorized_keys')
    }
  }
}

export type { AgentKind }
