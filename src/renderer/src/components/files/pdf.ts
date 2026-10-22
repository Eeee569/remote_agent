/**
 * PDF detection for the file viewer. The extension routes a tab to the PDF
 * view; the header check then guards against a misnamed file being handed to
 * Chromium's viewer, which would only show a blank error page.
 */

/** Larger than the 2 MiB text read cap: scanned papers and slides run big. */
export const PDF_READ_CAP_BYTES = 64 * 1024 * 1024

export function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path)
}

const MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d] // "%PDF-"
/** the spec lets readers accept the header anywhere in the first 1 KiB */
const HEADER_WINDOW = 1024

export function hasPdfHeader(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, HEADER_WINDOW) - MAGIC.length
  for (let i = 0; i <= end; i++) {
    let match = true
    for (let j = 0; j < MAGIC.length; j++) {
      if (bytes[i + j] !== MAGIC[j]) {
        match = false
        break
      }
    }
    if (match) return true
  }
  return false
}
