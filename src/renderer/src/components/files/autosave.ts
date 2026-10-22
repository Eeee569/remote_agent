/**
 * Autosave policy for the file viewer, kept separate from the editor so the
 * rules are testable.
 */

/** Idle time after the last keystroke before a write goes out. */
export const AUTOSAVE_DEBOUNCE_MS = 900

/**
 * SFTP reports mtimes with second precision, so a file we just wrote can come
 * back looking marginally newer than the timestamp we recorded.
 */
export const MTIME_SLACK_MS = 1000

/**
 * Did someone else write this file after the content we are holding? Used to
 * stop an autosave from silently overwriting an agent that edited the same
 * file. Unknown baselines and unreadable stats do not block the save — the
 * write itself will fail loudly if the file is really gone.
 */
export function remoteChangedSince(
  knownMtimeMs: number | undefined,
  remoteMtimeMs: number | null | undefined
): boolean {
  if (knownMtimeMs === undefined) return false
  if (remoteMtimeMs === null || remoteMtimeMs === undefined) return false
  return remoteMtimeMs > knownMtimeMs + MTIME_SLACK_MS
}
