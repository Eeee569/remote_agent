/**
 * The typed IPC contract between renderer and main.
 * - `CH` holds every channel name (invoke channels unless prefixed `evt:` / send-only noted).
 * - zod schemas validate payloads at the main-process boundary.
 * - `RendererApi` is the exact surface preload exposes as `window.api`.
 */
import { z } from 'zod'
import type {
  AgentFileInfo,
  BootstrapProgressEvent,
  BootstrapStatus,
  ConnEvent,
  ConnStatus,
  FileDiff,
  ClipboardPaste,
  FileReadResult,
  FileStat,
  GitStatus,
  HostPublic,
  HostSaveInput,
  HostTestResult,
  InstallTarget,
  ProjectLayout,
  ProjectMeta,
  SessionMeta,
  SessionSpec,
  SettingsReadResult,
  SettingsTarget,
  TermDataEvent,
  TermExitEvent,
  TermOpenInput,
  TreeEntry,
  TreeListing,
  Worktree,
  CodexWizardOptions
} from './domain'

// ---------------- channel names ----------------

export const CH = {
  ping: 'app:ping',

  hostsList: 'hosts:list',
  hostsSave: 'hosts:save',
  hostsDelete: 'hosts:delete',
  hostsTest: 'hosts:test',

  connConnect: 'conn:connect',
  connDisconnect: 'conn:disconnect',
  connStatus: 'conn:status',
  evtConn: 'evt:conn',

  bootstrapStatus: 'bootstrap:status',
  bootstrapInstall: 'bootstrap:install',
  evtBootstrapProgress: 'evt:bootstrap:progress',

  termOpen: 'term:open',
  termWrite: 'term:write', // send-only
  termResize: 'term:resize', // send-only
  termClose: 'term:close',
  evtTermData: 'evt:term:data',
  evtTermExit: 'evt:term:exit',

  clipboardWrite: 'clipboard:write', // send-only
  clipboardRead: 'clipboard:read',
  clipboardPaste: 'clipboard:paste',

  fsUploadPaths: 'fs:uploadPaths',
  fsUploadClipboard: 'fs:uploadClipboard',

  fsLsTree: 'fs:lsTree',
  fsLsTrees: 'fs:lsTrees',
  fsRead: 'fs:read',
  fsWrite: 'fs:write',
  fsHome: 'fs:home',
  fsStat: 'fs:stat',
  fsMove: 'fs:move',
  fsDelete: 'fs:delete',
  fsMkdir: 'fs:mkdir',
  gitStatus: 'git:status',

  projectList: 'project:list',
  projectAdd: 'project:add',
  projectRemove: 'project:remove',

  sessionCreate: 'session:create',
  sessionList: 'session:list',
  sessionKill: 'session:kill',

  worktreeList: 'worktree:list',

  layoutRead: 'layout:read',
  layoutWrite: 'layout:write',

  settingsRead: 'settings:read',
  settingsWrite: 'settings:write',
  agentsList: 'agents:list',
  agentsRead: 'agents:read',
  agentsWrite: 'agents:write',
  agentsDelete: 'agents:delete',
  codexWizardPreview: 'settings:codexWizard:preview',
  codexWizardApply: 'settings:codexWizard:apply'
} as const

export type ChannelName = (typeof CH)[keyof typeof CH]

// ---------------- zod payload schemas ----------------

export const hostSaveInputSchema = z.object({
  id: z.string().optional(),
  label: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1),
  authKind: z.enum(['key', 'agent']),
  keyPath: z.string().optional(),
  passphrase: z.string().nullable().optional()
})

export const hostIdSchema = z.object({ hostId: z.string().min(1) })

export const sessionSpecSchema = z.object({
  agent: z.enum(['claude', 'codex', 'shell']),
  mode: z.enum(['dir', 'worktree']),
  dir: z.string().optional(),
  branch: z.string().optional(),
  baseRef: z.string().optional(),
  tmuxName: z.string().optional(),
  launchCommand: z.string().optional()
})

export const termOpenSchema = z.object({
  hostId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  tmuxName: z.string().optional(),
  cwd: z.string().optional(),
  command: z.string().optional()
})

export const termWriteSchema = z.object({
  termId: z.string().min(1),
  data: z.instanceof(Uint8Array)
})

export const termResizeSchema = z.object({
  termId: z.string().min(1),
  cols: z.number().int().positive(),
  rows: z.number().int().positive()
})

/**
 * Cap matches the renderer's OSC 52 limit: the host can ask to set this
 * clipboard, so the payload is bounded on the way in.
 */
export const clipboardWriteSchema = z.object({
  text: z.string().max(1024 * 1024)
})

/** null `remoteDir`: stage under ~/.remote-agent/uploads, for handing to an agent */
export const fsUploadPathsSchema = z.object({
  hostId: z.string().min(1),
  paths: z
    .array(z.string().min(1).refine((p) => p.startsWith('/'), 'must be an absolute local path'))
    .min(1)
    .max(1000),
  remoteDir: z.string().min(1).nullable()
})

export const fsUploadClipboardSchema = z.object({
  hostId: z.string().min(1),
  remoteDir: z.string().min(1).nullable()
})

export const fsPathSchema = z.object({
  hostId: z.string().min(1),
  path: z.string().min(1)
})

export const fsReadSchema = fsPathSchema.extend({
  maxBytes: z.number().int().positive().optional()
})

export const fsWriteSchema = fsPathSchema.extend({
  data: z.instanceof(Uint8Array),
  mode: z.number().int().optional()
})

export const fsLsTreesSchema = z.object({
  hostId: z.string().min(1),
  paths: z.array(z.string().min(1)).max(200)
})

export const fsMoveSchema = z.object({
  hostId: z.string().min(1),
  src: z.string().min(1),
  dest: z.string().min(1)
})

export const fsDeleteSchema = fsPathSchema.extend({
  recursive: z.boolean().optional()
})

export const settingsTargetSchema = z.object({
  hostId: z.string().min(1),
  scope: z.enum(['user', 'project']),
  projectPath: z.string().optional(),
  file: z.enum(['settings', 'settingsLocal', 'mcp', 'claudeMd'])
})

export const settingsWriteSchema = settingsTargetSchema.extend({
  content: z.string()
})

export const agentsScopeSchema = z.object({
  hostId: z.string().min(1),
  scope: z.enum(['user', 'project']),
  projectPath: z.string().optional()
})

export const agentsReadSchema = agentsScopeSchema.extend({ name: z.string().min(1) })
export const agentsWriteSchema = agentsReadSchema.extend({ content: z.string() })

export const codexWizardOptionsSchema = z.object({
  hostId: z.string().min(1),
  projectPath: z.string().min(1),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  writeAgentFile: z.boolean().optional(),
  patchSettings: z.boolean().optional()
})

export const projectAddSchema = z.object({
  hostId: z.string().min(1),
  name: z.string().min(1),
  repoPath: z.string().min(1)
})

export const layoutWriteSchema = z.object({
  hostId: z.string().min(1),
  projectId: z.string().min(1),
  layout: z.object({
    dockview: z.unknown(),
    openFilesBySession: z.record(z.string(), z.array(z.string())),
    closedPanels: z.array(z.string()).optional(),
    sessionLayoutMode: z.enum(['focus', 'columns', 'rows', 'grid']).optional(),
    focusedSessionId: z.string().nullable().optional(),
    schemaVersion: z.number()
  })
})

export const bootstrapInstallSchema = z.object({
  hostId: z.string().min(1),
  targets: z.array(z.enum(['helper', 'claude', 'codex']))
})

// ---------------- renderer-facing API (window.api) ----------------

export interface RendererApi {
  ping(): Promise<string>

  // hosts
  hostsList(): Promise<HostPublic[]>
  hostsSave(input: HostSaveInput): Promise<HostPublic>
  hostsDelete(hostId: string): Promise<void>
  hostsTest(input: HostSaveInput): Promise<HostTestResult>

  // connection
  connConnect(hostId: string): Promise<ConnStatus>
  connDisconnect(hostId: string): Promise<void>
  connStatus(hostId: string): Promise<ConnStatus>
  onConn(cb: (e: ConnEvent) => void): () => void

  // bootstrap
  bootstrapStatus(hostId: string): Promise<BootstrapStatus>
  bootstrapInstall(hostId: string, targets: InstallTarget[]): Promise<{ ok: boolean }>
  onBootstrapProgress(cb: (e: BootstrapProgressEvent) => void): () => void

  // terminals
  termOpen(input: TermOpenInput): Promise<{ termId: string }>
  termWrite(termId: string, data: Uint8Array): void
  termResize(termId: string, cols: number, rows: number): void
  termClose(termId: string): Promise<void>
  onTermData(cb: (e: TermDataEvent) => void): () => void
  onTermExit(cb: (e: TermExitEvent) => void): () => void

  // clipboard — the OS clipboard via the main process, which works regardless of
  // document focus and needs no navigator.clipboard permission
  clipboardWrite(text: string): void
  clipboardRead(): Promise<string>
  /**
   * Terminal paste: text as is, or copied files/images uploaded to a staging
   * dir on the host and returned as their host paths.
   */
  clipboardPaste(hostId: string): Promise<ClipboardPaste>

  // local -> host uploads (null `remoteDir` = staging dir); resolve with the
  // host path of each top-level item
  /** `files` must be File objects from a real drop; their paths are read in the preload */
  fsUploadFiles(hostId: string, files: File[], remoteDir: string | null): Promise<string[]>
  /** copied files or image; null when the clipboard holds neither */
  fsUploadClipboard(hostId: string, remoteDir: string | null): Promise<string[] | null>

  // files / git
  fsLsTree(hostId: string, path: string): Promise<TreeEntry[]>
  /** one round trip for several directories; each result may carry an error */
  fsLsTrees(hostId: string, paths: string[]): Promise<TreeListing[]>
  fsRead(hostId: string, path: string, maxBytes?: number): Promise<FileReadResult>
  /** atomic replace; resolves with the file's stat after the write */
  fsWrite(hostId: string, path: string, data: Uint8Array, mode?: number): Promise<FileStat>
  /** null when the path does not exist */
  fsStat(hostId: string, path: string): Promise<FileStat | null>
  fsHome(hostId: string): Promise<string>
  /** move or rename; rejects when `dest` already exists. Returns the new path. */
  fsMove(hostId: string, src: string, dest: string): Promise<string>
  fsDelete(hostId: string, path: string, recursive?: boolean): Promise<void>
  fsMkdir(hostId: string, path: string): Promise<string>
  gitStatus(hostId: string, repoPath: string): Promise<GitStatus>

  // projects
  projectList(hostId: string): Promise<ProjectMeta[]>
  projectAdd(hostId: string, name: string, repoPath: string): Promise<ProjectMeta>
  projectRemove(hostId: string, projectId: string): Promise<void>

  // sessions
  sessionCreate(hostId: string, projectId: string, spec: SessionSpec): Promise<SessionMeta>
  sessionList(hostId: string, projectId: string): Promise<SessionMeta[]>
  sessionKill(
    hostId: string,
    projectId: string,
    sessionId: string,
    opts?: { alsoRemoveWorktree?: boolean }
  ): Promise<void>

  // worktrees
  worktreeList(hostId: string, repoPath: string): Promise<Worktree[]>

  // layout
  layoutRead(hostId: string, projectId: string): Promise<ProjectLayout | null>
  layoutWrite(hostId: string, projectId: string, layout: ProjectLayout): Promise<void>

  // settings
  settingsRead(target: SettingsTarget): Promise<SettingsReadResult>
  settingsWrite(target: SettingsTarget, content: string): Promise<void>
  agentsList(hostId: string, scope: 'user' | 'project', projectPath?: string): Promise<AgentFileInfo[]>
  agentsRead(
    hostId: string,
    scope: 'user' | 'project',
    name: string,
    projectPath?: string
  ): Promise<SettingsReadResult>
  agentsWrite(
    hostId: string,
    scope: 'user' | 'project',
    name: string,
    content: string,
    projectPath?: string
  ): Promise<void>
  agentsDelete(hostId: string, scope: 'user' | 'project', name: string, projectPath?: string): Promise<void>
  codexWizardPreview(opts: CodexWizardOptions): Promise<FileDiff[]>
  codexWizardApply(opts: CodexWizardOptions): Promise<{ filesChanged: string[] }>
}

/** Serializable error shape rethrown across the IPC boundary. */
export interface IpcErrorShape {
  name: string
  message: string
  code?: string
}
