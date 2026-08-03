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
  FileReadResult,
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

  fsLsTree: 'fs:lsTree',
  fsRead: 'fs:read',
  fsWrite: 'fs:write',
  fsHome: 'fs:home',
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

  // files / git
  fsLsTree(hostId: string, path: string): Promise<TreeEntry[]>
  fsRead(hostId: string, path: string, maxBytes?: number): Promise<FileReadResult>
  fsWrite(hostId: string, path: string, data: Uint8Array, mode?: number): Promise<void>
  fsHome(hostId: string): Promise<string>
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
