/**
 * Turning a file's bytes into text a <textarea> can edit, and back, without
 * changing anything the user did not touch. A file is only offered for editing
 * when decoding and re-encoding it reproduces the original bytes exactly.
 */

export interface EditableText {
  /** the text with `\n` line endings, as a textarea holds it */
  text: string
  eol: 'lf' | 'crlf'
  /** why the file can be viewed but not edited; null when it can be edited */
  readOnly: string | null
  /** true when the bytes are not text at all */
  binary: boolean
}

const encoder = new TextEncoder()

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** The bytes to write for `text` as edited (line endings restored). */
export function encodeText(text: string, eol: 'lf' | 'crlf'): Uint8Array {
  return encoder.encode(eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text)
}

export function decodeText(bytes: Uint8Array, truncated: boolean): EditableText {
  let raw: string
  let valid = true
  try {
    // ignoreBOM keeps a leading byte-order mark in the text so it is written back
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    valid = false
    raw = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)
  }
  if (raw.includes('\0')) return { text: '', eol: 'lf', readOnly: 'binary', binary: true }
  if (!valid) {
    // a cut-off file can end in the middle of a character; anything else is not UTF-8
    const bad = (raw.match(/�/g) ?? []).length
    if (!truncated || bad > 4) {
      const binary = bad / Math.max(raw.length, 1) > 0.01
      return {
        text: binary ? '' : raw,
        eol: 'lf',
        readOnly: 'This file is not UTF-8 text, so it cannot be edited here.',
        binary
      }
    }
  }

  let eol: 'lf' | 'crlf' = 'lf'
  let text = raw
  let readOnly: string | null = null
  if (raw.includes('\r')) {
    const crlf = (raw.match(/\r\n/g) ?? []).length
    const cr = (raw.match(/\r/g) ?? []).length
    const lf = (raw.match(/\n/g) ?? []).length
    if (crlf === cr && crlf === lf) {
      eol = 'crlf'
      text = raw.replace(/\r\n/g, '\n')
    } else {
      readOnly = 'This file mixes line endings, so it cannot be edited here.'
    }
  }
  if (truncated) {
    readOnly = 'This file is too large to edit here.'
  } else if (readOnly === null && !sameBytes(encodeText(text, eol), bytes)) {
    readOnly = 'This file cannot be edited here without altering it.'
  }
  return { text, eol, readOnly, binary: false }
}
