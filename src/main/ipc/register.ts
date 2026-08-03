/**
 * Full IPC registry: every channel in CH, validated with zod at the boundary,
 * wired to the ssh/services layer. Errors cross the boundary as
 * "[code] message" strings; events are broadcast to all windows.
 */
import { BrowserWindow, ipcMain } from 'electron'
import { z, ZodError } from 'zod'
import type {
  BootstrapProgressEvent,
  FileReadResult,
  HostSaveInput,
  ProjectLayout,
  TermDataEvent,
  TermExitEvent
} from '../../shared/domain'
import { HelperError } from '../../shared/helper-protocol'
import {
  CH,
  type ChannelName,
  agentsReadSchema,
  agentsScopeSchema,
  agentsWriteSchema,
  bootstrapInstallSchema,
  codexWizardOptionsSchema,
  fsPathSchema,
  fsReadSchema,
  fsWriteSchema,
  hostIdSchema,
  hostSaveInputSchema,
  layoutWriteSchema,
  projectAddSchema,
  sessionSpecSchema,
  settingsTargetSchema,
  settingsWriteSchema,
  termOpenSchema,
  termResizeSchema,
  termWriteSchema
} from '../../shared/ipc'
import { deleteHost, getHost, getPassphrase, listHosts, saveHost, toPublic } from '../store/hosts'
import { getConnectionManager, testHost } from '../ssh/connection-manager'
import { getSftpService } from '../ssh/sftp-service'
import { getTerminalService } from '../ssh/terminal-service'
import * as bootstrapSvc from '../services/bootstrap'
import { codexApply, codexPreview } from '../services/codex-wizard'
import { getHelperClient } from '../services/helper-client'
import * as settingsSvc from '../services/settings'
import * as state from '../services/state'
import { buildAttachCommand } from '../services/tmux'
import { CodedError } from '../util/errors'

// ---------------- local payload schemas ----------------

const projectRemoveSchema = z.object({
  hostId: z.string().min(1),
  projectId: z.string().min(1)
})

const projectScopedSchema = z.object({
  hostId: z.string().min(1),
  projectId: z.string().min(1)
})

const sessionCreateSchema = z.object({
  hostId: z.string().min(1),
  projectId: z.string().min(1),
  spec: sessionSpecSchema
})

const sessionKillSchema = z.object({
  hostId: z.string().min(1),
  projectId: z.string().min(1),
  sessionId: z.string().min(1),
  alsoRemoveWorktree: z.boolean().optional()
})

const worktreeListSchema = z.object({
  hostId: z.string().min(1),
  repoPath: z.string().min(1)
})

const termCloseSchema = z.object({ termId: z.string().min(1) })

// ---------------- plumbing ----------------

/** Converts CodedError/HelperError/ZodError into a renderer-readable Error. */
function toIpcError(err: unknown): Error {
  if (err instanceof CodedError || err instanceof HelperError) {
    return new Error(`[${err.code}] ${err.message}`)
  }
  if (err instanceof ZodError) {
    const detail = err.issues
      .map((i) => `${i.path.join('.') || '(payload)'}: ${i.message}`)
      .join('; ')
    return new Error(`[bad-args] ${detail}`)
  }
  if (err instanceof Error) return new Error(err.message)
  return new Error(String(err))
}

function broadcast(ch: ChannelName, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(ch, payload)
  }
}

const broadcastProgress = (e: BootstrapProgressEvent): void =>
  broadcast(CH.evtBootstrapProgress, e)

function handle<S extends z.ZodTypeAny>(
  ch: ChannelName,
  schema: S,
  fn: (p: z.output<S>) => unknown
): void
function handle(ch: ChannelName, schema: null, fn: () => unknown): void
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handle(ch: ChannelName, schema: z.ZodTypeAny | null, fn: (p: any) => unknown): void {
  ipcMain.handle(ch, async (_e, payload: unknown) => {
    try {
      const p = schema ? schema.parse(payload ?? {}) : payload
      return await fn(p)
    } catch (err) {
      throw toIpcError(err)
    }
  })
}

// ---------------- registry ----------------

export function registerIpc(): void {
  const cm = getConnectionManager()
  const terms = getTerminalService()

  // event forwarding: main services -> every renderer window
  cm.onStatus((e) => {
    broadcast(CH.evtConn, e)
    // keep the helper current on every (re)connect; failures surface as
    // bootstrap progress events, never as connection errors
    if (e.status === 'connected') {
      void bootstrapSvc.ensureHelper(e.hostId, broadcastProgress)
    }
  })
  terms.on('data', (e: TermDataEvent) => broadcast(CH.evtTermData, e))
  terms.on('exit', (e: TermExitEvent) => broadcast(CH.evtTermExit, e))

  handle(CH.ping, null, () => 'pong')

  // ---------------- hosts ----------------

  handle(CH.hostsList, null, () => listHosts().map(toPublic))

  handle(CH.hostsSave, hostSaveInputSchema, (p) => toPublic(saveHost(p)))

  handle(CH.hostsDelete, hostIdSchema, ({ hostId }) => {
    deleteHost(hostId)
  })

  handle(CH.hostsTest, hostSaveInputSchema, (p) => {
    const stored = p.id ? getHost(p.id) : undefined
    // fill secrets the form does not re-send from the stored record
    const passphrase =
      p.passphrase !== undefined ? p.passphrase : stored ? getPassphrase(stored) : undefined
    const keyPath =
      p.keyPath ?? (stored?.auth.kind === 'key' ? stored.auth.keyPath : undefined)
    const input: HostSaveInput = {
      ...p,
      ...(keyPath !== undefined ? { keyPath } : {}),
      ...(passphrase !== undefined ? { passphrase } : {})
    }
    return testHost(input, stored?.hostKey?.fingerprint)
  })

  // ---------------- connection ----------------

  handle(CH.connConnect, hostIdSchema, async ({ hostId }) => {
    cm.setWanted(hostId, true)
    await cm.connect(hostId)
    // helper check/install must never fail the connect
    void bootstrapSvc.ensureHelper(hostId, broadcastProgress)
    return cm.status(hostId)
  })

  handle(CH.connDisconnect, hostIdSchema, async ({ hostId }) => {
    cm.setWanted(hostId, false)
    await cm.disconnect(hostId)
  })

  handle(CH.connStatus, hostIdSchema, ({ hostId }) => cm.status(hostId))

  // ---------------- bootstrap ----------------

  handle(CH.bootstrapStatus, hostIdSchema, ({ hostId }) => bootstrapSvc.bootstrapStatus(hostId))

  handle(CH.bootstrapInstall, bootstrapInstallSchema, ({ hostId, targets }) => {
    // runs async: progress + per-target completion arrive as
    // evt:bootstrap:progress events ({done:true, ok:<bool>} per target)
    void bootstrapSvc.installTargets(hostId, targets, broadcastProgress)
    return { ok: true }
  })

  // ---------------- terminals ----------------

  handle(CH.termOpen, termOpenSchema, (p) => {
    const command = p.tmuxName ? buildAttachCommand(p.tmuxName, p.cwd) : p.command
    return terms.open({
      hostId: p.hostId,
      cols: p.cols,
      rows: p.rows,
      ...(command !== undefined ? { command } : {})
    })
  })

  ipcMain.on(CH.termWrite, (_e, payload: unknown) => {
    const r = termWriteSchema.safeParse(payload)
    if (r.success) terms.write(r.data.termId, r.data.data)
  })

  ipcMain.on(CH.termResize, (_e, payload: unknown) => {
    const r = termResizeSchema.safeParse(payload)
    if (r.success) terms.resize(r.data.termId, r.data.cols, r.data.rows)
  })

  handle(CH.termClose, termCloseSchema, ({ termId }) => terms.close(termId))

  // ---------------- files / git ----------------

  handle(CH.fsLsTree, fsPathSchema, ({ hostId, path }) =>
    getHelperClient(hostId).lsTree(path, true)
  )

  handle(CH.fsRead, fsReadSchema, async (p): Promise<FileReadResult> => {
    const res = await getSftpService(p.hostId).readFile(p.path, p.maxBytes)
    return {
      data: new Uint8Array(res.data),
      truncated: res.truncated,
      size: res.size,
      mtimeMs: res.mtimeMs
    }
  })

  handle(CH.fsWrite, fsWriteSchema, async (p) => {
    await getSftpService(p.hostId).writeFileAtomic(p.path, Buffer.from(p.data), p.mode)
  })

  handle(CH.fsHome, hostIdSchema, ({ hostId }) => bootstrapSvc.remoteHome(hostId))

  handle(CH.gitStatus, fsPathSchema, ({ hostId, path }) => getHelperClient(hostId).gitStatus(path))

  // ---------------- projects / sessions / worktrees / layout ----------------

  handle(CH.projectList, hostIdSchema, ({ hostId }) => state.projectList(hostId))

  handle(CH.projectAdd, projectAddSchema, ({ hostId, name, repoPath }) =>
    state.projectAdd(hostId, name, repoPath)
  )

  handle(CH.projectRemove, projectRemoveSchema, ({ hostId, projectId }) =>
    state.projectRemove(hostId, projectId)
  )

  handle(CH.sessionCreate, sessionCreateSchema, ({ hostId, projectId, spec }) =>
    state.sessionCreate(hostId, projectId, spec)
  )

  handle(CH.sessionList, projectScopedSchema, ({ hostId, projectId }) =>
    state.sessionList(hostId, projectId)
  )

  handle(CH.sessionKill, sessionKillSchema, ({ hostId, projectId, sessionId, alsoRemoveWorktree }) =>
    state.sessionKill(hostId, projectId, sessionId, alsoRemoveWorktree)
  )

  handle(CH.worktreeList, worktreeListSchema, ({ hostId, repoPath }) =>
    getHelperClient(hostId).worktreeList(repoPath)
  )

  handle(CH.layoutRead, projectScopedSchema, ({ hostId, projectId }) =>
    state.layoutRead(hostId, projectId)
  )

  handle(CH.layoutWrite, layoutWriteSchema, async (p) => {
    const layout: ProjectLayout = {
      dockview: p.layout.dockview ?? null,
      openFilesBySession: p.layout.openFilesBySession,
      schemaVersion: p.layout.schemaVersion
    }
    await state.layoutWrite(p.hostId, p.projectId, layout)
  })

  // ---------------- settings / agents / codex wizard ----------------

  handle(CH.settingsRead, settingsTargetSchema, (target) => settingsSvc.settingsRead(target))

  handle(CH.settingsWrite, settingsWriteSchema, async (p) => {
    const { content, ...target } = p
    await settingsSvc.settingsWrite(target, content)
  })

  handle(CH.agentsList, agentsScopeSchema, ({ hostId, scope, projectPath }) =>
    settingsSvc.agentsList(hostId, scope, projectPath)
  )

  handle(CH.agentsRead, agentsReadSchema, ({ hostId, scope, name, projectPath }) =>
    settingsSvc.agentsRead(hostId, scope, name, projectPath)
  )

  handle(CH.agentsWrite, agentsWriteSchema, ({ hostId, scope, name, content, projectPath }) =>
    settingsSvc.agentsWrite(hostId, scope, name, content, projectPath)
  )

  handle(CH.agentsDelete, agentsReadSchema, ({ hostId, scope, name, projectPath }) =>
    settingsSvc.agentsDelete(hostId, scope, name, projectPath)
  )

  handle(CH.codexWizardPreview, codexWizardOptionsSchema, (opts) => codexPreview(opts))

  handle(CH.codexWizardApply, codexWizardOptionsSchema, (opts) => codexApply(opts))
}
