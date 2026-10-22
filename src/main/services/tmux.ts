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
 * Clipboard options applied on the way in, as tmux commands chained ahead of the
 * attach.
 *
 * They are also in tmux.conf, but that file is read once when a tmux server
 * starts — and this app's whole point is that servers outlive the client, so a
 * session started before these options existed would never pick them up. Both
 * are idempotent, so re-applying them on every attach costs nothing.
 *
 * `-q` matters more than it looks: an error here would abort the chain and take
 * the attach with it, leaving the user with no terminal at all. It suppresses
 * the unknown-option error from a tmux predating `allow-passthrough` (3.3), and
 * `-g` is used over the nominally correct `-s` because tmux routes server-scoped
 * options itself, while older versions scoped `set-clipboard` to the session.
 */
const CLIPBOARD_OPTS = ['set-option -gq set-clipboard on', 'set-option -gq allow-passthrough on']

/**
 * Single-line command (no trailing newline; the caller appends one) that
 * replaces the login shell with a tmux attach-or-create for `tmuxName`.
 */
export function buildAttachCommand(tmuxName: string, cwd?: string): string {
  // `\;` reaches tmux as a bare `;`, which separates its own commands — one
  // invocation, so the options are set before the client attaches
  const setup = CLIPBOARD_OPTS.map((opt) => `${opt} \\; `).join('')
  return (
    `exec tmux -f ${HELPER_TMUX_CONF} ${setup}new-session -A -s ${shQuote(tmuxName)}` +
    (cwd !== undefined ? ` -c ${shQuote(cwd)}` : '')
  )
}

/** "ra-<project>-<hint>", lowercase alnum+dash, truncated to 40 chars. */
export function suggestTmuxName(projectName: string, hint: string): string {
  const name = TMUX_PREFIX + slug(projectName) + '-' + slug(hint)
  return name.slice(0, MAX_NAME_LEN).replace(/-+$/, '')
}
