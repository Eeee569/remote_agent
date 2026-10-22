import { describe, expect, it } from 'vitest'
import { MAX_CLIPBOARD_BYTES, parseOsc52 } from './osc52'

/** Builds the payload an OSC handler receives for `text`. */
function osc52(text: string, targets = 'c'): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return `${targets};${btoa(bin)}`
}

describe('parseOsc52', () => {
  it('decodes what the host asked to put on the clipboard', () => {
    expect(parseOsc52(osc52('hello from the server'))).toBe('hello from the server')
  })

  /*
   * Captured from xterm.js 5.5 by writing ESC]52;c;<b64>BEL to a live terminal:
   * the handler is given the payload with "52;" already stripped, and an
   * ST-terminated sequence with no target arrives with the target empty.
   */
  it('matches the payload xterm.js actually hands an OSC handler', () => {
    expect(parseOsc52('c;ZnJvbSB0aGUgaG9zdCDinJM=')).toBe('from the host ✓')
    expect(parseOsc52(';ZnJvbSB0aGUgaG9zdCDinJM=')).toBe('from the host ✓')
  })

  it('round-trips multi-line text and non-ASCII', () => {
    const text = 'line one\nline two\n\tindented — ünïcode ✓ 日本語'
    expect(parseOsc52(osc52(text))).toBe(text)
  })

  it('accepts the clipboard, primary, select and default targets', () => {
    for (const target of ['c', 'p', 's', '', 'cp']) {
      expect(parseOsc52(osc52('x', target))).toBe('x')
    }
  })

  it('ignores cut-buffer targets the app does not keep', () => {
    expect(parseOsc52(osc52('x', '0'))).toBeNull()
    expect(parseOsc52(osc52('x', 'q'))).toBeNull()
  })

  it('never answers a clipboard read request', () => {
    // "?" asks us to ship the local clipboard to the host
    expect(parseOsc52('c;?')).toBeNull()
    expect(parseOsc52(';?')).toBeNull()
  })

  it('treats an empty payload as clearing the clipboard', () => {
    expect(parseOsc52('c;')).toBe('')
  })

  it('tolerates wrapped base64 and missing padding', () => {
    const wrapped = osc52('hello from the server').replace(/(.{8})/g, '$1\n')
    expect(parseOsc52(wrapped)).toBe('hello from the server')
    expect(parseOsc52(osc52('abcde').replace(/=+$/, ''))).toBe('abcde')
  })

  it('rejects malformed sequences instead of pasting garbage', () => {
    expect(parseOsc52('c')).toBeNull() // no separator at all
    expect(parseOsc52('c;not base64!')).toBeNull()
    expect(parseOsc52('c;A')).toBeNull() // impossible base64 length
  })

  it('refuses a payload far larger than any real clipboard', () => {
    const huge = 'c;' + 'A'.repeat(MAX_CLIPBOARD_BYTES * 2)
    expect(parseOsc52(huge)).toBeNull()
  })
})
