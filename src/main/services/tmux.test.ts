import { describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { buildAttachCommand, slug, suggestTmuxName } from './tmux'

describe('slug', () => {
  it('lowercases and collapses non-alphanumerics', () => {
    expect(slug('My Project')).toBe('my-project')
    expect(slug('feature/JIRA-123__fix')).toBe('feature-jira-123-fix')
    expect(slug('--leading and trailing--')).toBe('leading-and-trailing')
  })

  it('never returns an empty slug', () => {
    expect(slug('')).toBe('x')
    expect(slug('///')).toBe('x')
    expect(slug('ブランチ')).toBe('x')
  })
})

describe('suggestTmuxName', () => {
  it('builds ra-<project>-<hint>', () => {
    expect(suggestTmuxName('webapp', 'fix-auth')).toBe('ra-webapp-fix-auth')
  })

  it('caps length without leaving a trailing dash', () => {
    const name = suggestTmuxName('a'.repeat(30), 'b'.repeat(30))
    expect(name.length).toBeLessThanOrEqual(40)
    expect(name.endsWith('-')).toBe(false)
  })

  it('produces names tmux accepts (no dots, colons or whitespace)', () => {
    const name = suggestTmuxName('My App v1.2', 'feature/new thing')
    expect(name).toMatch(/^ra-[a-z0-9-]+$/)
  })
})

describe('buildAttachCommand', () => {
  /** Splits the command the way a POSIX shell would, so quoting can be asserted. */
  function shellWords(cmd: string): string[] {
    const out = execFileSync('/bin/sh', ['-c', `for w in ${cmd}; do printf '%s\\n' "$w"; done`], {
      encoding: 'utf8'
    })
    return out.split('\n').slice(0, -1)
  }

  it('attaches-or-creates the named session', () => {
    const cmd = buildAttachCommand('ra-demo')
    expect(cmd).toContain('new-session -A -s ra-demo')
    expect(cmd.startsWith('exec tmux ')).toBe(true)
    expect(cmd).not.toContain('\n')
  })

  it('passes the working directory when given', () => {
    expect(buildAttachCommand('ra-demo', '/srv/app')).toContain('-c /srv/app')
  })

  it('keeps hostile session names and paths as single shell words', () => {
    // strip the leading `exec` so the rest parses as a plain word list
    const cmd = buildAttachCommand("ra-x'; id; echo '", '/tmp/a b/$(id)').replace(/^exec /, '')
    const words = shellWords(cmd)
    expect(words).toContain("ra-x'; id; echo '")
    expect(words).toContain('/tmp/a b/$(id)')
    // the payloads must survive verbatim — nothing was executed or expanded
    expect(words.some((w) => w.includes('uid='))).toBe(false)
  })
})
