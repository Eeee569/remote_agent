/**
 * tmux command construction + session naming. The attach command is typed
 * into a PTY shell channel by the terminal service; `new-session -A` attaches
 * when the session exists and creates it otherwise.
 */
import { HELPER_TMUX_CONF, TMUX_PREFIX } from '../../shared/helper-protocol'
import { shQuote } from '../util/sh'

const MAX_NAME_LEN = 40

/** Lowercase alnum+dash slug; collapses runs, trims leading/trailing dashes. */
export function slug(s: string): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return out.length > 0 ? out : 'x'
}

/**
 * Single-line command (no trailing newline; the caller appends one) that
 * replaces the login shell with a tmux attach-or-create for `tmuxName`.
 */
export function buildAttachCommand(tmuxName: string, cwd?: string): string {
  return (
    `exec tmux -f ${HELPER_TMUX_CONF} new-session -A -s ${shQuote(tmuxName)}` +
    (cwd !== undefined ? ` -c ${shQuote(cwd)}` : '')
  )
}

/** "ra-<project>-<hint>", lowercase alnum+dash, truncated to 40 chars. */
export function suggestTmuxName(projectName: string, hint: string): string {
  const name = TMUX_PREFIX + slug(projectName) + '-' + slug(hint)
  return name.slice(0, MAX_NAME_LEN).replace(/-+$/, '')
}
