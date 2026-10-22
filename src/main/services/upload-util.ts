/**
 * Pure helpers for uploading local files to the host: naming, limits, and
 * reading file lists off the clipboard. Kept free of electron/ssh imports so
 * they can be unit tested.
 */
import { posix } from 'path'

/** Refuse an upload this big up front — an accidental node_modules drop, say. */
export const UPLOAD_MAX_FILES = 5000
export const UPLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024

/** Host directory that chat pastes and drops are staged under. */
export const UPLOAD_STAGING_ROOT = '~/.remote-agent/uploads'

/**
 * `name`, or Finder-style "name (1).ext", "name (2).ext", … — the first one
 * not in `taken`. The extension is the part after the last dot, unless the
 * name starts with its only dot (".env" has no extension).
 */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 1; ; n++) {
    const candidate = `${stem} (${n})${ext}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Fresh per-paste directory name, sortable by time: "20261002-035616-a1b2c3". */
export function stagingDirName(now: Date, rand: string): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-` +
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  return `${stamp}-${rand}`
}

/** Name for a pasted clipboard image, e.g. "pasted-image-035616.png". */
export function pastedImageName(now: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `pasted-image-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}.png`
}

/** Local paths from a text/uri-list (RFC 2483): file:// URLs only, comments skipped. */
export function parseUriList(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const path = fileUrlToPath(line)
    if (path !== null) out.push(path)
  }
  return out
}

/** Absolute local path for a file:// URL, or null for anything else. */
export function fileUrlToPath(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'file:' || (parsed.host !== '' && parsed.host !== 'localhost')) {
    return null
  }
  try {
    const path = decodeURIComponent(parsed.pathname)
    return path.startsWith('/') ? path : null
  } catch {
    return null
  }
}

/** A single path segment safe to create on the host, or null. */
export function safeEntryName(name: string): string | null {
  const base = posix.basename(name)
  if (base === '' || base === '.' || base === '..' || base.includes('/')) return null
  return base
}
