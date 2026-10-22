import { describe, expect, it } from 'vitest'
import { describeProjectTarget } from './project-target'

const repo = (over: Partial<{ isRepo: boolean; hasCommit: boolean; branch: string | null }> = {}) => ({
  isRepo: true,
  hasCommit: true,
  branch: 'main',
  ...over
})

const notRepo = { isRepo: false, hasCommit: false, branch: null }

describe('describeProjectTarget', () => {
  it('offers to create a path that does not exist', () => {
    const t = describeProjectTarget({ stat: null, git: null })
    expect(t.blocked).toBe(false)
    expect(t.message).toMatch(/created/)
  })

  it('blocks a path that is a file', () => {
    const t = describeProjectTarget({ stat: { isDir: false }, git: null })
    expect(t.blocked).toBe(true)
    expect(t.tone).toBe('error')
  })

  it('leaves an existing repository alone', () => {
    const t = describeProjectTarget({ stat: { isDir: true }, git: repo(), entryCount: 4 })
    expect(t.tone).toBe('info')
    expect(t.message).toContain('main')
    expect(t.message).toMatch(/untouched/)
  })

  it('warns before committing the contents of a plain directory', () => {
    const t = describeProjectTarget({ stat: { isDir: true }, git: notRepo, entryCount: 12 })
    expect(t.tone).toBe('warn')
    expect(t.message).toMatch(/initial commit/)
    expect(t.blocked).toBe(false)
  })

  it('does not warn about committing an empty directory', () => {
    const t = describeProjectTarget({ stat: { isDir: true }, git: notRepo, entryCount: 0 })
    expect(t.tone).toBe('info')
    expect(t.message).toMatch(/Empty directory/)
  })

  it('warns that a commitless repository is about to get one', () => {
    const t = describeProjectTarget({
      stat: { isDir: true },
      git: repo({ hasCommit: false }),
      entryCount: 3
    })
    expect(t.tone).toBe('warn')
    expect(t.message).toMatch(/no commits/)
  })

  it('assumes the cautious message when the directory was not listed', () => {
    // entryCount unknown must not read as "empty"
    const t = describeProjectTarget({ stat: { isDir: true }, git: notRepo })
    expect(t.tone).toBe('warn')
  })
})
