/**
 * OSC 52 — the escape sequence a program writes to put text on the *client's*
 * clipboard. xterm.js ships no handler for it, so every attempt by the host to
 * reach this Mac's clipboard was being dropped on the floor: tmux copy-mode,
 * vim's oscyank, and agent CLIs that offer "copy this" all speak OSC 52.
 *
 * Kept pure so the decoding and — more importantly — the refusals can be tested
 * without a terminal.
 */

/** Payloads above this are treated as junk rather than a clipboard write. */
export const MAX_CLIPBOARD_BYTES = 1024 * 1024

/** base64 length that can decode to at most MAX_CLIPBOARD_BYTES. */
const MAX_B64_LEN = Math.ceil((MAX_CLIPBOARD_BYTES * 4) / 3) + 4

/**
 * Targets that mean "the clipboard" here: `c`lipboard, `p`rimary, `s`elect, and
 * the empty default. A GUI terminal has one system clipboard, so all three map
 * onto it. Numeric targets (cut buffers 0-7) are a terminal-local store the app
 * does not keep, so those sequences are dropped.
 */
const CLIPBOARD_TARGETS = /^[cps]*$/

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * Decodes the payload of an `ESC ] 52 ; <targets> ; <data>` sequence — the part
 * xterm hands to an OSC handler, with the leading `52;` already stripped.
 *
 * Returns the text to place on the clipboard, or null when the sequence must be
 * ignored (a read request, an unsupported target, or a malformed/oversized
 * payload). An empty string is a real result: it clears the clipboard.
 */
export function parseOsc52(payload: string): string | null {
  const sep = payload.indexOf(';')
  if (sep === -1) return null

  const targets = payload.slice(0, sep)
  if (!CLIPBOARD_TARGETS.test(targets)) return null

  const data = payload.slice(sep + 1)
  /*
   * "?" asks the terminal to send its clipboard back to the host. Answering
   * would hand whatever is on this Mac's clipboard to code running on the
   * server, so the read half of OSC 52 stays unimplemented on purpose.
   */
  if (data === '?') return null
  if (data.length > MAX_B64_LEN) return null

  // some senders wrap long base64 across lines
  const b64 = data.replace(/\s+/g, '')
  if (b64 === '') return ''
  if (!BASE64.test(b64)) return null

  try {
    // tolerate senders that omit the trailing padding
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')
    const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0))
    if (bytes.length > MAX_CLIPBOARD_BYTES) return null
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}
