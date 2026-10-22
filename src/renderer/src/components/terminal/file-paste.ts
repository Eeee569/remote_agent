/**
 * Turning uploaded files into terminal input. A file dragged into a local
 * terminal arrives as its path, backslash-escaped the way Terminal.app does
 * it — which is what agent CLIs (Claude Code's image attach included) look
 * for — so uploads are pasted the same way.
 */

/** non-ASCII letters are left as is, as Terminal.app does */
const SAFE = /[A-Za-z0-9_\-./~+,@%:=]|[^\x00-\x7f]/u

export function escapePathForShell(path: string): string {
  let out = ''
  for (const ch of path) out += SAFE.test(ch) ? ch : `\\${ch}`
  return out
}

/** Space-separated escaped paths with a trailing space, ready to keep typing after. */
export function pastedPathsText(paths: readonly string[]): string {
  return paths.length === 0 ? '' : paths.map(escapePathForShell).join(' ') + ' '
}

/** True when a drag carries files from outside the app (Finder, the desktop). */
export function isExternalFileDrag(types: readonly string[]): boolean {
  return types.includes('Files')
}
