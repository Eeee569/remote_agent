/**
 * Pure helpers for copying host files to this computer. Kept free of
 * electron/ssh imports so they can be unit tested.
 */

/** How long a drag-out link stays fetchable after the drag starts. */
export const DRAG_LINK_TTL_MS = 10 * 60_000

/** Local copies older than this are swept from the downloads staging dir. */
export const LOCAL_STAGING_MAX_AGE_MS = 24 * 60 * 60_000

/**
 * Value for the `DownloadURL` drag type, which Chromium turns into a file
 * the OS fetches only when the drag is dropped in Finder (or a desktop).
 * Format is "mime:filename:url"; a colon in the name would end the field.
 */
export function downloadUrlData(name: string, url: string): string {
  return `application/octet-stream:${name.replace(/:/g, '_')}:${url}`
}

/** RFC 6266 Content-Disposition for a download named `name`. */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

/**
 * Local file mode for a downloaded file: the host's permission bits, but
 * always readable and writable by you, so Finder can copy it out of staging.
 */
export function localFileMode(remoteMode: number): number {
  return (remoteMode & 0o777) | 0o600
}
