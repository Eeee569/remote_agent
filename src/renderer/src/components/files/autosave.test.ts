import { describe, expect, it } from 'vitest'
import { MTIME_SLACK_MS, remoteChangedSince } from './autosave'

describe('remoteChangedSince', () => {
  const base = 1_700_000_000_000

  it('is false when the file has not moved since we read it', () => {
    expect(remoteChangedSince(base, base)).toBe(false)
    expect(remoteChangedSince(base, base - 5000)).toBe(false)
  })

  it('tolerates the second-precision mtimes SFTP reports', () => {
    expect(remoteChangedSince(base, base + MTIME_SLACK_MS)).toBe(false)
    expect(remoteChangedSince(base, base + MTIME_SLACK_MS + 1)).toBe(true)
  })

  it('is true once someone else writes the file', () => {
    expect(remoteChangedSince(base, base + 30_000)).toBe(true)
  })

  it('does not block a save when there is nothing to compare', () => {
    // no baseline yet (never loaded), or the stat failed / file is gone:
    // the write itself is the better place to fail
    expect(remoteChangedSince(undefined, base + 30_000)).toBe(false)
    expect(remoteChangedSince(base, null)).toBe(false)
    expect(remoteChangedSince(base, undefined)).toBe(false)
  })
})
