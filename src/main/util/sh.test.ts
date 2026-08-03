import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { shQuote } from './sh'

/**
 * Every value here is user-supplied somewhere in the app (branch names, tmux
 * session names, paths, launch commands) and ends up inside a remote command
 * line, so the contract is checked against a real shell rather than by
 * comparing strings.
 */
const NASTY = [
  'plain',
  'with space',
  "single'quote",
  "it's a 'nested' quote",
  'double"quote',
  'back\\slash',
  '$HOME',
  '${HOME}',
  '`id`',
  '$(id)',
  'a;id',
  'a && id',
  'a || id',
  'a | id',
  'a > /tmp/pwned',
  'a\nid',
  'a\tb',
  '*',
  '?',
  '~root',
  '#comment',
  '!history',
  'branch/with/slashes',
  'ünïcode-ブランチ',
  '--dash-leading',
  '-',
  '',
  ' ',
  "';id;'",
  '\\\'"$(id)`id`',
  'a'.repeat(300)
]

/** Round-trips `value` through `sh -c 'printf %s <quoted>'`. */
function shellEcho(quoted: string): string {
  return execFileSync('/bin/sh', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' })
}

describe('shQuote', () => {
  it.each(NASTY)('round-trips %j through a real shell unchanged', (value) => {
    expect(shellEcho(shQuote(value))).toBe(value)
  })

  it('never lets a payload reach the shell as code', () => {
    // if quoting leaked, the command substitution would run and the marker vanish
    for (const payload of ['$(echo PWNED)', '`echo PWNED`', '; echo PWNED', '&& echo PWNED']) {
      expect(shellEcho(shQuote(payload))).toBe(payload)
    }
  })

  it('quotes anything outside the literal-safe set', () => {
    expect(shQuote('')).toBe("''")
    expect(shQuote('a b')).toBe("'a b'")
    expect(shQuote("a'b")).toBe("'a'\\''b'")
  })

  it('leaves shell-literal words unquoted', () => {
    for (const safe of ['abc', 'a-b_c', '/usr/local/bin', 'v1.2.3', 'a@b:c,d=e%f+g']) {
      expect(shQuote(safe)).toBe(safe)
    }
  })
})
