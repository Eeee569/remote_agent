/**
 * Types + zod schemas for the JSON protocol spoken by server-helper/helper.py.
 * Every helper invocation prints exactly one JSON envelope on stdout:
 *   success: {"ok": true,  "data": ...}
 *   failure: {"ok": false, "error": {"code": "...", "message": "..."}}  (exit code 1)
 */
import { z } from 'zod'

export const HELPER_HOME = '~/.remote-agent'
export const HELPER_PATH = '~/.remote-agent/bin/helper'
export const HELPER_TMUX_CONF = '~/.remote-agent/tmux.conf'
/** tmux sessions created by the app are prefixed with this */
export const TMUX_PREFIX = 'ra-'
/** suffix of the companion plain-shell tmux session that every session gets */
export const SHELL_SUFFIX = '-shell'

/**
 * tmux session name of a session's companion shell. Created lazily by the
 * `new-session -A` attach the shell panel issues, killed with the session.
 */
export function shellTmuxName(tmuxName: string): string {
  return tmuxName + SHELL_SUFFIX
}

export const helperErrorSchema = z.object({
  code: z.string(),
  message: z.string()
})

export const helperEnvelopeSchema = z.union([
  z.object({ ok: z.literal(true), data: z.unknown() }),
  z.object({ ok: z.literal(false), error: helperErrorSchema })
])

export type HelperErrorPayload = z.infer<typeof helperErrorSchema>

/** Typed error thrown by helper-client when the helper reports ok:false. */
export class HelperError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'HelperError'
  }
}

// ---------- per-subcommand data schemas ----------

export const helperVersionSchema = z.object({
  version: z.string(),
  sha256: z.string().optional(),
  home: z.string().optional()
})

export const treeEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(['dir', 'file', 'symlink', 'other']),
  size: z.number(),
  mtime: z.number(),
  mode: z.string(),
  linkTargetType: z.enum(['dir', 'file']).optional()
})

export const lsTreeSchema = z.object({
  entries: z.array(treeEntrySchema)
})

/** One batch entry: either a listing or the error that directory hit. */
export const lsTreesSchema = z.object({
  trees: z.array(
    z.object({
      path: z.string(),
      entries: z.array(treeEntrySchema).optional(),
      error: helperErrorSchema.optional()
    })
  )
})

export const gitStatusSchema = z.object({
  isRepo: z.boolean(),
  hasCommit: z.boolean(),
  branch: z.string().nullable(),
  upstream: z.string().nullable(),
  ahead: z.number(),
  behind: z.number(),
  staged: z.array(z.string()),
  modified: z.array(z.string()),
  untracked: z.array(z.string())
})

/**
 * git-init reports what it had to do: `initialized` when the directory was not
 * a repo, `committed` when it had no commit for a worktree to branch from.
 */
export const gitInitSchema = z.object({
  path: z.string(),
  initialized: z.boolean(),
  committed: z.boolean(),
  branch: z.string().nullable()
})

/** fs-move / fs-mkdir echo the resulting absolute path. */
export const fsPathResultSchema = z.object({
  path: z.string()
})

export const tmuxSessionSchema = z.object({
  tmuxName: z.string(),
  alive: z.boolean(),
  attachedClients: z.number(),
  cwd: z.string().nullable(),
  createdAt: z.number().nullable()
})

export const sessionListSchema = z.object({
  sessions: z.array(tmuxSessionSchema)
})

export const worktreeSchema = z.object({
  path: z.string(),
  branch: z.string().nullable(),
  head: z.string(),
  isMain: z.boolean()
})

export const worktreeListSchema = z.object({
  worktrees: z.array(worktreeSchema)
})

export const worktreeAddSchema = z.object({
  path: z.string(),
  branch: z.string()
})

export const readStateSchema = z.object({
  version: z.number(),
  state: z.unknown()
})

export const writeStateSchema = z.object({
  version: z.number()
})

export const okSchema = z.object({}).passthrough()

export type HelperVersion = z.infer<typeof helperVersionSchema>
export type HelperLsTree = z.infer<typeof lsTreeSchema>
export type HelperGitStatus = z.infer<typeof gitStatusSchema>
export type HelperGitInit = z.infer<typeof gitInitSchema>
export type HelperSessionList = z.infer<typeof sessionListSchema>
export type HelperWorktreeList = z.infer<typeof worktreeListSchema>
export type HelperReadState = z.infer<typeof readStateSchema>

/** Error codes emitted by helper.py (keep in sync). */
export const HELPER_ERROR_CODES = [
  'bad-args',
  'not-found',
  'not-a-repo',
  'not-a-dir',
  'exists',
  'not-empty',
  'conflict',
  'tmux-missing',
  'tmux-failed',
  'git-failed',
  'session-exists',
  'session-missing',
  'io-error',
  'internal'
] as const
export type HelperErrorCode = (typeof HELPER_ERROR_CODES)[number]
