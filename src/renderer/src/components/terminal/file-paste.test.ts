import { describe, expect, it } from 'vitest'
import { escapePathForShell, isExternalFileDrag, pastedPathsText } from './file-paste'

describe('escapePathForShell', () => {
  it('leaves plain paths alone', () => {
    expect(escapePathForShell('/home/u/.remote-agent/uploads/x/report-v2.pdf')).toBe(
      '/home/u/.remote-agent/uploads/x/report-v2.pdf'
    )
  })

  it('escapes spaces and shell metacharacters like Terminal.app', () => {
    expect(escapePathForShell('/tmp/a file (1).png')).toBe('/tmp/a\\ file\\ \\(1\\).png')
    expect(escapePathForShell("/tmp/it's$x&y;z")).toBe("/tmp/it\\'s\\$x\\&y\\;z")
  })

  it('leaves non-ASCII letters alone', () => {
    expect(escapePathForShell('/tmp/café résumé.txt')).toBe('/tmp/café\\ résumé.txt')
  })
})

describe('pastedPathsText', () => {
  it('joins with spaces and leaves a trailing one to keep typing', () => {
    expect(pastedPathsText(['/a', '/b c'])).toBe('/a /b\\ c ')
  })

  it('is empty for nothing', () => {
    expect(pastedPathsText([])).toBe('')
  })
})

describe('isExternalFileDrag', () => {
  it('spots drags carrying files', () => {
    expect(isExternalFileDrag(['Files'])).toBe(true)
    expect(isExternalFileDrag(['text/plain'])).toBe(false)
  })
})
