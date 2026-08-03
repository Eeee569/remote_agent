/**
 * Server-side project/session/layout state, persisted through the helper's
 * versioned read-state/write-state calls with optimistic concurrency.
 *   index (no project id): { projects: ProjectMeta[] }
 *   per-project:           ProjectState minus `version` (the helper envelope
 *                          carries the version)
 */
import { posix } from 'path'
import type {
  ProjectLayout,
  ProjectMeta,
  SessionMeta,
  SessionSpec
} from '../../shared/domain'
import { HelperError } from '../../shared/helper-protocol'
import { CodedError } from '../util/errors'
import { newId } from '../util/ids'
import { remoteHome } from './bootstrap'
import { getHelperClient } from './helper-client'
import { slug, suggestTmuxName } from './tmux'

interface IndexState {
  projects: ProjectMeta[]
}

/** ProjectState from shared/domain minus `version` (lives in the wrapper). */
interface ProjectStateBody {
  project: ProjectMeta
  sessions: SessionMeta[]
  layout: ProjectLayout
  updatedAt: number
}

function defaultLayout(): ProjectLayout {
  return { dockview: null, openFilesBySession: {}, schemaVersion: 1 }
}

/**
 * Read-modify-write with retry on version conflict. `mutate` receives the
 * current state (null when none) and returns the full next state.
 */
async function mutateState<T>(
  hostId: string,
  projectId: string | undefined,
  mutate: (cur: T | null) => T,
  attempts = 3
): Promise<T> {
  const client = getHelperClient(hostId)
  let lastErr: unknown = null
  for (let i = 0; i < attempts; i++) {
    const { version, state } = await client.readState(projectId)
    const next = mutate((state ?? null) as T | null)
    try {
      await client.writeState(projectId, version, next)
      return next
    } catch (err) {
      if (err instanceof HelperError && err.code === 'conflict' && i < attempts - 1) {
        lastErr = err
        continue
      }
      throw err
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new CodedError('conflict', 'state write kept conflicting')
}

// ---------------- projects ----------------

export async function projectList(hostId: string): Promise<ProjectMeta[]> {
  const { state } = await getHelperClient(hostId).readState()
  const index = state as IndexState | null
  return index?.projects ?? []
}

async function resolveProject(hostId: string, projectId: string): Promise<ProjectMeta> {
  const projects = await projectList(hostId)
  const project = projects.find((p) => p.id === projectId)
  if (!project) throw new CodedError('not-found', `project ${projectId} not found`)
  return project
}

export async function projectAdd(
  hostId: string,
  name: string,
  repoPath: string
): Promise<ProjectMeta> {
  const gs = await getHelperClient(hostId).gitStatus(repoPath)
  if (!gs.isRepo) {
    throw new CodedError('not-a-repo', `not a git repository: ${repoPath}`)
  }
  const meta: ProjectMeta = { id: newId('p_'), name, repoPath, createdAt: Date.now() }
  await mutateState<IndexState>(hostId, undefined, (cur) => ({
    projects: [...(cur?.projects ?? []), meta]
  }))
  return meta
}

/** Removes the project from the index only; server files are never deleted. */
export async function projectRemove(hostId: string, projectId: string): Promise<void> {
  await mutateState<IndexState>(hostId, undefined, (cur) => ({
    projects: (cur?.projects ?? []).filter((p) => p.id !== projectId)
  }))
}

// ---------------- sessions ----------------

/** Stored sessions joined with live tmux info (missing in tmux -> alive:false). */
export async function sessionList(hostId: string, projectId: string): Promise<SessionMeta[]> {
  const client = getHelperClient(hostId)
  const [{ state }, live] = await Promise.all([
    client.readState(projectId),
    client.sessionList()
  ])
  const stored = (state as ProjectStateBody | null)?.sessions ?? []
  const liveByName = new Map(live.map((s) => [s.tmuxName, s]))
  return stored.map((s) => {
    const t = liveByName.get(s.tmuxName)
    return {
      ...s,
      alive: t !== undefined,
      attachedClients: t?.attachedClients ?? 0
    }
  })
}

export async function sessionCreate(
  hostId: string,
  projectId: string,
  spec: SessionSpec
): Promise<SessionMeta> {
  const client = getHelperClient(hostId)
  const project = await resolveProject(hostId, projectId)

  // resolve working directory (and create the worktree if needed)
  let cwd: string
  let worktree: SessionMeta['worktree']
  if (spec.mode === 'worktree') {
    if (!spec.branch) {
      throw new CodedError('bad-args', 'worktree mode requires a branch name')
    }
    const home = await remoteHome(hostId)
    const path = `${home}/.remote-agent/worktrees/${projectId}/${slug(spec.branch)}`
    const added = await client.worktreeAdd({
      repo: project.repoPath,
      path,
      branch: spec.branch,
      ...(spec.baseRef !== undefined ? { base: spec.baseRef } : {})
    })
    cwd = added.path
    worktree = {
      path: added.path,
      branch: added.branch,
      ...(spec.baseRef !== undefined ? { baseRef: spec.baseRef } : {})
    }
  } else {
    if (!spec.dir) {
      throw new CodedError('bad-args', 'dir mode requires a directory')
    }
    cwd = spec.dir
  }

  // pick a unique tmux session name
  const hint = spec.branch || posix.basename(cwd) || 'session'
  const base = spec.tmuxName || suggestTmuxName(project.name, hint)
  const [{ state }, live] = await Promise.all([
    client.readState(projectId),
    client.sessionList()
  ])
  const taken = new Set<string>(live.map((s) => s.tmuxName))
  for (const s of (state as ProjectStateBody | null)?.sessions ?? []) taken.add(s.tmuxName)
  let tmuxName = base
  for (let n = 2; taken.has(tmuxName); n++) tmuxName = `${base}-${n}`

  // launch the tmux session (detached) with the agent command
  const launchCmd =
    spec.launchCommand ||
    (spec.agent === 'claude' ? 'claude' : spec.agent === 'codex' ? 'codex' : undefined)
  await client.sessionCreate({
    name: tmuxName,
    cwd,
    agent: spec.agent,
    ...(launchCmd !== undefined ? { cmd: launchCmd } : {})
  })

  const meta: SessionMeta = {
    id: newId('s_'),
    projectId,
    tmuxName,
    agent: spec.agent,
    mode: spec.mode,
    cwd,
    ...(worktree !== undefined ? { worktree } : {}),
    createdAt: Date.now()
  }
  await mutateState<ProjectStateBody>(hostId, projectId, (cur) => ({
    project: cur?.project ?? project,
    sessions: [...(cur?.sessions ?? []), meta],
    layout: cur?.layout ?? defaultLayout(),
    updatedAt: Date.now()
  }))
  return { ...meta, alive: true, attachedClients: 0 }
}

export async function sessionKill(
  hostId: string,
  projectId: string,
  sessionId: string,
  alsoRemoveWorktree?: boolean
): Promise<void> {
  const client = getHelperClient(hostId)
  const { state } = await client.readState(projectId)
  const body = state as ProjectStateBody | null
  const meta = body?.sessions.find((s) => s.id === sessionId)
  if (!body || !meta) throw new CodedError('not-found', `session ${sessionId} not found`)

  try {
    await client.sessionKill(meta.tmuxName)
  } catch (err) {
    if (!(err instanceof HelperError && err.code === 'session-missing')) throw err
  }

  if (alsoRemoveWorktree && meta.mode === 'worktree' && meta.worktree) {
    await client.worktreeRemove(body.project.repoPath, meta.worktree.path, true)
  }

  await mutateState<ProjectStateBody>(hostId, projectId, (cur) => ({
    project: cur?.project ?? body.project,
    sessions: (cur?.sessions ?? []).filter((s) => s.id !== sessionId),
    layout: cur?.layout ?? defaultLayout(),
    updatedAt: Date.now()
  }))
}

// ---------------- layout ----------------

export async function layoutRead(hostId: string, projectId: string): Promise<ProjectLayout | null> {
  const { state } = await getHelperClient(hostId).readState(projectId)
  return (state as ProjectStateBody | null)?.layout ?? null
}

export async function layoutWrite(
  hostId: string,
  projectId: string,
  layout: ProjectLayout
): Promise<void> {
  const project = await resolveProject(hostId, projectId)
  await mutateState<ProjectStateBody>(hostId, projectId, (cur) => ({
    project: cur?.project ?? project,
    sessions: cur?.sessions ?? [],
    layout,
    updatedAt: Date.now()
  }))
}
