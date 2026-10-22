/**
 * POSIX path helpers for the remote file tree. Remote paths are always
 * absolute and "/"-separated (the helper returns os.path.abspath output), so
 * these deliberately do not deal with Windows separators or relative paths.
 */

/** Parent directory of a path; "/" for top-level entries. */
export function dirnameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const at = trimmed.lastIndexOf('/')
  return at <= 0 ? '/' : trimmed.slice(0, at)
}

export function basenameOf(path: string): string {
  return path.replace(/\/+$/, '').split('/').pop() ?? path
}

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`
}

/**
 * True when `path` is `dir` itself or lives underneath it. Used to refuse
 * moving a directory into its own subtree and to find viewer tabs affected
 * by a move or delete.
 */
export function isInside(dir: string, path: string): boolean {
  const base = dir.replace(/\/+$/, '')
  if (base === '') return true // "/" contains everything
  return path === base || path.startsWith(base + '/')
}

/**
 * A single path segment, or null when the input could escape the directory
 * it is meant to be created in ("..", "a/b", empty, whitespace only).
 */
export function validName(raw: string): string | null {
  const name = raw.trim()
  if (name === '' || name === '.' || name === '..' || name.includes('/')) return null
  return name
}
