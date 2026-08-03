/**
 * POSIX shell quoting for strings interpolated into remote command lines.
 * Kept dependency-free so it can be unit tested without pulling in Electron.
 */

/**
 * Quotes `s` so a POSIX shell reads it back as exactly one literal word.
 * Unquoted only for characters that are literal to every POSIX shell.
 */
export function shQuote(s: string): string {
  if (s.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s
  return "'" + s.replace(/'/g, "'\\''") + "'"
}
