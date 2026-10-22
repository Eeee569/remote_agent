/**
 * Which terminal key presses the app handles itself instead of forwarding to
 * the PTY. Kept pure so the one rule that really matters — never swallow the
 * Ctrl+C that interrupts an agent — is pinned by tests.
 */

export interface KeyLike {
  type: string
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
}

export type TerminalKeyAction = 'copy' | 'paste' | 'select-all' | 'pass'

/**
 * macOS copies with ⌘C, which the terminal never receives anyway. Elsewhere
 * copying needs Shift (Ctrl+Shift+C): plain Ctrl+C always goes through as
 * SIGINT, selection or not.
 */
export function terminalKeyAction(
  event: KeyLike,
  opts: { isMac: boolean; hasSelection: boolean }
): TerminalKeyAction {
  if (event.type !== 'keydown') return 'pass'
  const key = event.key.toLowerCase()
  const mod = opts.isMac ? event.metaKey : event.ctrlKey
  if (!mod) return 'pass'

  if (key === 'c') {
    const wantsCopy = opts.isMac ? !event.ctrlKey : event.shiftKey
    return wantsCopy && opts.hasSelection ? 'copy' : 'pass'
  }
  /*
   * Paste is handled here rather than left to the browser's paste event: that
   * event only arrives when the platform's Edit menu happens to be wired up,
   * and plain Ctrl+V must stay a literal keystroke (readline/vim own it).
   */
  if (key === 'v') {
    const wantsPaste = opts.isMac ? !event.ctrlKey : event.shiftKey
    return wantsPaste ? 'paste' : 'pass'
  }
  // ⌘A would otherwise select the hidden textarea, which does nothing useful
  if (key === 'a' && opts.isMac) return 'select-all'
  return 'pass'
}
