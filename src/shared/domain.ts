/**
 * Core domain types shared by main, preload, and renderer.
 * Server-persisted shapes (ProjectState, SessionMeta, ...) must stay in sync
 * with server-helper/helper.py.
 */

// ---------- Hosts / connection ----------

export type AuthKind = 'key' | 'agent'

/** Full host record as stored locally in main (never sent to renderer verbatim). */
export interface HostConfig {
  id: string
  label: string
  host: string
  port: number
  username: string
  auth:
    | { kind: 'key'; keyPath: string; passphraseEnc?: string }
    | { kind: 'agent' }
  /** TOFU-pinned host key, set on first successful connect. */
  hostKey?: { algo: string; fingerprint: string }
}

/** Sanitized host record exposed to the renderer (no secrets). */
export interface HostPublic {
  id: string
  label: string
  host: string
  port: number
  username: string
  authKind: AuthKind
  keyPath?: string
  hasPassphrase: boolean
  hostKeyFingerprint?: string
}

/**
 * Renderer -> main host upsert. `passphrase` semantics:
 * undefined = leave stored passphrase unchanged, null = clear it,
 * string = encrypt & store.
 */
export interface HostSaveInput {
  id?: string
  label: string
  host: string
  port: number
  username: string
  authKind: AuthKind
  keyPath?: string
  passphrase?: string | null
}

export interface HostTestResult {
  ok: boolean
  error?: string
  banner?: string
  hostKeyFingerprint?: string
  hostKeyAlgo?: string
}

export type ConnStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

export interface ConnEvent {
  hostId: string
  status: ConnStatus
  /** reconnect attempt number, when status === 'reconnecting' */
  attempt?: number
  nextRetryMs?: number
  error?: string
}

// ---------- Bootstrap / install ----------

export interface ToolStatus {
  present: boolean
  version?: string
  /** for the helper: bundled sha256 matches installed */
  upToDate?: boolean
}

export interface BootstrapStatus {
  python3: ToolStatus
  tmux: ToolStatus
  git: ToolStatus
  helper: ToolStatus
  claude: ToolStatus
  codex: ToolStatus
}

export type InstallTarget = 'helper' | 'claude' | 'codex'

export interface BootstrapProgressEvent {
  hostId: string
  target: InstallTarget | 'probe'
  line: string
  done?: boolean
  ok?: boolean
}

// ---------- Projects / sessions ----------

export type AgentKind = 'claude' | 'codex' | 'shell'

export interface ProjectMeta {
  id: string
  name: string
  repoPath: string
  createdAt: number
}

export interface WorktreeInfo {
  path: string
  branch: string
  baseRef?: string
}

/** Session record persisted in server state; live fields joined from `tmux ls`. */
export interface SessionMeta {
  id: string
  projectId: string
  tmuxName: string
  agent: AgentKind
  mode: 'dir' | 'worktree'
  cwd: string
  worktree?: WorktreeInfo
  createdAt: number
  createdBy?: string
  // live (not persisted)
  alive?: boolean
  attachedClients?: number
}

export interface SessionSpec {
  agent: AgentKind
  mode: 'dir' | 'worktree'
  /** required when mode === 'dir' */
  dir?: string
  /** required when mode === 'worktree' */
  branch?: string
  baseRef?: string
  /** auto-generated `ra-<project>-<slug>` when omitted */
  tmuxName?: string
  /** override the agent launch command (defaults: `claude`, `codex`, login shell) */
  launchCommand?: string
}

export interface Worktree {
  path: string
  branch: string | null
  head: string
  isMain: boolean
}

// ---------- Server-persisted state ----------

export interface ProjectLayout {
  /** verbatim dockview api.toJSON() output */
  dockview: unknown | null
  openFilesBySession: Record<string, string[]>
  schemaVersion: number
}

export interface ProjectState {
  version: number
  project: ProjectMeta
  sessions: SessionMeta[]
  layout: ProjectLayout
  updatedAt: number
}

// ---------- Files / git ----------

export type TreeEntryType = 'dir' | 'file' | 'symlink' | 'other'

export interface TreeEntry {
  name: string
  path: string
  type: TreeEntryType
  size: number
  mtime: number
  mode: string
  /** target type for symlinks that resolve to a directory */
  linkTargetType?: 'dir' | 'file'
}

export interface GitStatus {
  isRepo: boolean
  branch: string | null
  upstream: string | null
  ahead: number
  behind: number
  staged: string[]
  modified: string[]
  untracked: string[]
}

export interface FileReadResult {
  /** UTF-8 bytes of the file (possibly truncated) */
  data: Uint8Array
  truncated: boolean
  size: number
  mtimeMs: number
}

// ---------- Claude Code settings surface ----------

export type SettingsScope = 'user' | 'project'

/** Which config file a settings read/write targets. */
export type SettingsFileKind =
  | 'settings' // ~/.claude/settings.json or <project>/.claude/settings.json
  | 'settingsLocal' // <project>/.claude/settings.local.json
  | 'mcp' // <project>/.mcp.json (project scope only)
  | 'claudeMd' // CLAUDE.md (project root) or ~/.claude/CLAUDE.md

export interface SettingsTarget {
  hostId: string
  scope: SettingsScope
  /** absolute repo path; required for scope === 'project' */
  projectPath?: string
  file: SettingsFileKind
}

export interface SettingsReadResult {
  content: string
  exists: boolean
  path: string
}

export interface AgentFileInfo {
  name: string
  path: string
  scope: SettingsScope
}

export interface FileDiff {
  path: string
  before: string
  after: string
}

export interface CodexWizardOptions {
  hostId: string
  projectPath: string
  /** MCP server launch command; default `codex` + ["mcp-server"] */
  command?: string
  args?: string[]
  /** also write .claude/agents/codex-worker.md */
  writeAgentFile?: boolean
  /** also patch .claude/settings.json enable/allow lists */
  patchSettings?: boolean
}

// ---------- Terminals ----------

export interface TermOpenInput {
  hostId: string
  cols: number
  rows: number
  /** attach to this tmux session (via `tmux new-session -A`) */
  tmuxName?: string
  cwd?: string
  /** raw command to exec instead of tmux attach (M1 / debugging) */
  command?: string
}

export type TermExitReason = 'detach' | 'error' | 'conn-lost' | 'closed'

export interface TermDataEvent {
  termId: string
  data: Uint8Array
}

export interface TermExitEvent {
  termId: string
  reason: TermExitReason
  message?: string
}
