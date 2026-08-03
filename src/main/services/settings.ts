/**
 * Claude Code settings-file surface on the remote host: settings.json /
 * settings.local.json / .mcp.json / CLAUDE.md path resolution + sftp
 * read/write, and the .claude/agents/*.md file collection.
 */
import { posix } from 'path'
import type {
  AgentFileInfo,
  SettingsReadResult,
  SettingsScope,
  SettingsTarget
} from '../../shared/domain'
import { getSftpService } from '../ssh/sftp-service'
import { CodedError } from '../util/errors'
import { remoteHome } from './bootstrap'

const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

// ---------------- path resolution ----------------

export function resolveSettingsPath(target: SettingsTarget, home: string): string {
  if (target.scope === 'user') {
    switch (target.file) {
      case 'settings':
        return posix.join(home, '.claude', 'settings.json')
      case 'claudeMd':
        return posix.join(home, '.claude', 'CLAUDE.md')
      default:
        throw new CodedError('bad-args', `${target.file} is not valid for user scope`)
    }
  }
  const p = target.projectPath
  if (!p) throw new CodedError('bad-args', 'projectPath is required for project scope')
  switch (target.file) {
    case 'settings':
      return posix.join(p, '.claude', 'settings.json')
    case 'settingsLocal':
      return posix.join(p, '.claude', 'settings.local.json')
    case 'mcp':
      return posix.join(p, '.mcp.json')
    case 'claudeMd':
      return posix.join(p, 'CLAUDE.md')
  }
}

// ---------------- text file helpers (shared with codex-wizard) ----------------

/** Reads a remote UTF-8 text file; a missing file yields exists:false, "". */
export async function readTextFile(hostId: string, path: string): Promise<SettingsReadResult> {
  try {
    const res = await getSftpService(hostId).readFile(path)
    return { content: res.data.toString('utf8'), exists: true, path }
  } catch (err) {
    if (err instanceof CodedError && err.code === 'not-found') {
      return { content: '', exists: false, path }
    }
    throw err
  }
}

/** mkdirp parent + atomic write of a UTF-8 text file. */
export async function writeTextFile(hostId: string, path: string, content: string): Promise<void> {
  const sftp = getSftpService(hostId)
  await sftp.mkdirp(posix.dirname(path))
  await sftp.writeFileAtomic(path, Buffer.from(content, 'utf8'))
}

// ---------------- settings files ----------------

export async function settingsRead(target: SettingsTarget): Promise<SettingsReadResult> {
  const home = await remoteHome(target.hostId)
  return readTextFile(target.hostId, resolveSettingsPath(target, home))
}

export async function settingsWrite(target: SettingsTarget, content: string): Promise<void> {
  const home = await remoteHome(target.hostId)
  await writeTextFile(target.hostId, resolveSettingsPath(target, home), content)
}

// ---------------- agent files (.claude/agents/*.md) ----------------

export async function agentsDir(
  hostId: string,
  scope: SettingsScope,
  projectPath?: string
): Promise<string> {
  if (scope === 'user') {
    return posix.join(await remoteHome(hostId), '.claude', 'agents')
  }
  if (!projectPath) throw new CodedError('bad-args', 'projectPath is required for project scope')
  return posix.join(projectPath, '.claude', 'agents')
}

function validAgentName(name: string): string {
  if (!AGENT_NAME_RE.test(name)) {
    throw new CodedError('bad-args', `invalid agent name: ${name} (lowercase alnum + dashes only)`)
  }
  return name
}

export async function agentsList(
  hostId: string,
  scope: SettingsScope,
  projectPath?: string
): Promise<AgentFileInfo[]> {
  const dir = await agentsDir(hostId, scope, projectPath)
  let entries: Array<{ name: string; isDir: boolean }>
  try {
    entries = await getSftpService(hostId).readdir(dir)
  } catch (err) {
    if (err instanceof CodedError && err.code === 'not-found') return []
    throw err
  }
  return entries
    .filter((e) => !e.isDir && e.name.endsWith('.md'))
    .map((e) => ({
      name: e.name.slice(0, -'.md'.length),
      path: posix.join(dir, e.name),
      scope
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function agentsRead(
  hostId: string,
  scope: SettingsScope,
  name: string,
  projectPath?: string
): Promise<SettingsReadResult> {
  const dir = await agentsDir(hostId, scope, projectPath)
  return readTextFile(hostId, posix.join(dir, validAgentName(name) + '.md'))
}

export async function agentsWrite(
  hostId: string,
  scope: SettingsScope,
  name: string,
  content: string,
  projectPath?: string
): Promise<void> {
  const dir = await agentsDir(hostId, scope, projectPath)
  await writeTextFile(hostId, posix.join(dir, validAgentName(name) + '.md'), content)
}

export async function agentsDelete(
  hostId: string,
  scope: SettingsScope,
  name: string,
  projectPath?: string
): Promise<void> {
  const dir = await agentsDir(hostId, scope, projectPath)
  try {
    await getSftpService(hostId).unlink(posix.join(dir, validAgentName(name) + '.md'))
  } catch (err) {
    // deleting an already-missing agent is a no-op
    if (!(err instanceof CodedError && err.code === 'not-found')) throw err
  }
}
