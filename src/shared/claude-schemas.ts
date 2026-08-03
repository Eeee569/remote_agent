/**
 * Hand-authored JSON Schemas for Claude Code config files, used by Monaco's
 * JSON language service in the settings editors. Deliberately permissive
 * (additionalProperties: true) — unknown keys must never be flagged or lost.
 */

export const claudeSettingsJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: true,
  properties: {
    model: {
      type: 'string',
      description: 'Default model (e.g. "claude-opus-5", "sonnet", "haiku")'
    },
    env: {
      type: 'object',
      description: 'Environment variables applied to every session',
      additionalProperties: { type: 'string' }
    },
    permissions: {
      type: 'object',
      additionalProperties: true,
      properties: {
        allow: { type: 'array', items: { type: 'string' }, description: 'Permission rules to allow, e.g. "Bash(npm run *)"' },
        ask: { type: 'array', items: { type: 'string' } },
        deny: { type: 'array', items: { type: 'string' }, description: 'Permission rules to deny, e.g. "Read(./.env)"' },
        additionalDirectories: { type: 'array', items: { type: 'string' } },
        defaultMode: {
          type: 'string',
          enum: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk']
        }
      }
    },
    permissionMode: {
      type: 'string',
      enum: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk']
    },
    hooks: {
      type: 'object',
      description: 'Lifecycle hooks: event name -> matcher groups',
      additionalProperties: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            matcher: { type: 'string' },
            hooks: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  type: { type: 'string', enum: ['command', 'http', 'prompt'] },
                  command: { type: 'string' },
                  url: { type: 'string' },
                  prompt: { type: 'string' },
                  timeout: { type: 'number' }
                }
              }
            }
          }
        }
      },
      propertyNames: {
        enum: [
          'SessionStart',
          'SessionEnd',
          'UserPromptSubmit',
          'PreToolUse',
          'PostToolUse',
          'PostToolUseFailure',
          'PermissionRequest',
          'Notification',
          'Stop',
          'SubagentStart',
          'SubagentStop'
        ]
      }
    },
    enableAllProjectMcpServers: { type: 'boolean' },
    enabledMcpjsonServers: { type: 'array', items: { type: 'string' } },
    disabledMcpjsonServers: { type: 'array', items: { type: 'string' } },
    additionalDirectories: { type: 'array', items: { type: 'string' } }
  }
} as const

export const mcpJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  additionalProperties: true,
  properties: {
    mcpServers: {
      type: 'object',
      description: 'MCP server registry: name -> transport config',
      additionalProperties: {
        type: 'object',
        additionalProperties: true,
        properties: {
          type: { type: 'string', enum: ['stdio', 'http', 'sse', 'ws'] },
          command: { type: 'string', description: 'stdio: executable' },
          args: { type: 'array', items: { type: 'string' } },
          env: { type: 'object', additionalProperties: { type: 'string' } },
          url: { type: 'string', description: 'http/sse/ws: endpoint URL' },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          timeout: { type: 'number' }
        }
      }
    }
  },
  required: ['mcpServers']
} as const

/** Frontmatter fields for .claude/agents/<name>.md, used by the agents editor form. */
export const AGENT_FRONTMATTER_FIELDS = [
  { key: 'name', required: true, hint: 'unique id, lowercase-with-hyphens' },
  { key: 'description', required: true, hint: 'when Claude should delegate to this agent' },
  { key: 'tools', required: false, hint: 'comma-separated allowlist, e.g. "Read, Grep, Bash"' },
  { key: 'model', required: false, hint: 'sonnet | opus | haiku | inherit | full model id' },
  { key: 'permissionMode', required: false, hint: 'default | acceptEdits | plan | bypassPermissions' }
] as const

/** Default content for the Codex sub-agent definition written by the wizard. */
export const CODEX_WORKER_AGENT_MD = `---
name: codex-worker
description: >-
  Delegate self-contained implementation tasks (writing code, refactors,
  test authoring) to OpenAI Codex. Use the mcp__codex__codex tool to start a
  task and mcp__codex__codex-reply to continue one. Prefer this agent when the
  user asks for Codex, or for parallelizable implementation work you want to
  hand off while you orchestrate.
tools: mcp__codex__codex, mcp__codex__codex-reply, Read, Grep, Glob
---

You are an orchestration shim around OpenAI Codex.

For each task you receive:
1. Start a Codex session with mcp__codex__codex, passing a precise,
   self-contained prompt: the goal, the relevant file paths, and the working
   directory. Codex runs on this machine and edits files directly.
2. Inspect Codex's result. If it needs steering, continue the same session
   with mcp__codex__codex-reply rather than starting over.
3. Verify the outcome yourself (Read the changed files) before reporting.

Report back: what changed, which files, and anything Codex could not do.
`
