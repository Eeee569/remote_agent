/**
 * "Use Codex from Claude" wizard: computes (preview) and applies the three
 * project-file changes that register Codex as an MCP server for Claude Code:
 *   <p>/.mcp.json                      — mcpServers.codex stdio entry
 *   <p>/.claude/agents/codex-worker.md — delegation sub-agent definition
 *   <p>/.claude/settings.json          — enable + allow the codex MCP server
 * Existing file content is parsed and preserved; only the needed keys change.
 */
import { posix } from 'path'
import { CODEX_WORKER_AGENT_MD } from '../../shared/claude-schemas'
import type { CodexWizardOptions, FileDiff } from '../../shared/domain'
import { CodedError } from '../util/errors'
import { readTextFile, writeTextFile } from './settings'

type JsonObject = Record<string, unknown>

function isRecord(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Missing/empty -> {}; anything unparseable or non-object is an error. */
function parseJsonObject(content: string, path: string): JsonObject {
  if (content.trim().length === 0) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    throw new CodedError('invalid-json', `cannot parse ${path}: ${(err as Error).message}`)
  }
  if (!isRecord(parsed)) {
    throw new CodedError('invalid-json', `${path} must contain a JSON object`)
  }
  return parsed
}

function stringify(obj: JsonObject): string {
  return JSON.stringify(obj, null, 2) + '\n'
}

async function computeChanges(opts: CodexWizardOptions): Promise<FileDiff[]> {
  const { hostId, projectPath } = opts
  const writeAgentFile = opts.writeAgentFile !== false
  const patchSettings = opts.patchSettings !== false
  const changes: FileDiff[] = []
  const push = (path: string, before: string, after: string): void => {
    if (before !== after) changes.push({ path, before, after })
  }

  // 1) <p>/.mcp.json — register the codex MCP server
  {
    const path = posix.join(projectPath, '.mcp.json')
    const { content: before } = await readTextFile(hostId, path)
    const obj = parseJsonObject(before, path)
    const servers = isRecord(obj.mcpServers) ? { ...obj.mcpServers } : {}
    servers['codex'] = {
      type: 'stdio',
      command: opts.command || 'codex',
      args: opts.args ?? ['mcp-server']
    }
    push(path, before, stringify({ ...obj, mcpServers: servers }))
  }

  // 2) <p>/.claude/agents/codex-worker.md — delegation sub-agent
  if (writeAgentFile) {
    const path = posix.join(projectPath, '.claude', 'agents', 'codex-worker.md')
    const { content: before } = await readTextFile(hostId, path)
    push(path, before, CODEX_WORKER_AGENT_MD)
  }

  // 3) <p>/.claude/settings.json — enable server + allow its tools
  if (patchSettings) {
    const path = posix.join(projectPath, '.claude', 'settings.json')
    const { content: before } = await readTextFile(hostId, path)
    const obj = parseJsonObject(before, path)

    const enabled = Array.isArray(obj.enabledMcpjsonServers) ? [...obj.enabledMcpjsonServers] : []
    if (!enabled.includes('codex')) enabled.push('codex')

    const permissions = isRecord(obj.permissions) ? { ...obj.permissions } : {}
    const allow = Array.isArray(permissions.allow) ? [...permissions.allow] : []
    if (!allow.includes('mcp__codex__*')) allow.push('mcp__codex__*')
    permissions.allow = allow

    push(
      path,
      before,
      stringify({ ...obj, enabledMcpjsonServers: enabled, permissions })
    )
  }

  return changes
}

/** Diffs for every file the wizard would change (identical files skipped). */
export async function codexPreview(opts: CodexWizardOptions): Promise<FileDiff[]> {
  return computeChanges(opts)
}

/** Applies the changes atomically and reports which files were written. */
export async function codexApply(opts: CodexWizardOptions): Promise<{ filesChanged: string[] }> {
  const changes = await computeChanges(opts)
  for (const change of changes) {
    await writeTextFile(opts.hostId, change.path, change.after)
  }
  return { filesChanged: changes.map((c) => c.path) }
}
