import { describe, expect, it } from 'vitest'
import {
  fileUrlToPath,
  parseUriList,
  pastedImageName,
  safeEntryName,
  stagingDirName,
  uniqueName
} from './upload-util'

describe('uniqueName', () => {
  it('keeps a free name as is', () => {
    expect(uniqueName('notes.md', new Set(['other.md']))).toBe('notes.md')
  })

  it('numbers a taken name before its extension, Finder-style', () => {
    expect(uniqueName('notes.md', new Set(['notes.md']))).toBe('notes (1).md')
    expect(uniqueName('notes.md', new Set(['notes.md', 'notes (1).md']))).toBe('notes (2).md')
  })

  it('treats dotfiles and extensionless names as having no extension', () => {
    expect(uniqueName('.env', new Set(['.env']))).toBe('.env (1)')
    expect(uniqueName('Makefile', new Set(['Makefile']))).toBe('Makefile (1)')
  })

  it('numbers only the last extension', () => {
    expect(uniqueName('a.tar.gz', new Set(['a.tar.gz']))).toBe('a.tar (1).gz')
  })
})

describe('stagingDirName / pastedImageName', () => {
  const at = new Date(2026, 9, 2, 3, 56, 16)

  it('is sortable by time and unique per paste', () => {
    expect(stagingDirName(at, 'a1b2c3')).toBe('20261002-035616-a1b2c3')
  })

  it('names pasted images by time', () => {
    expect(pastedImageName(at)).toBe('pasted-image-035616.png')
  })
})

describe('fileUrlToPath / parseUriList', () => {
  it('decodes file URLs', () => {
    expect(fileUrlToPath('file:///tmp/a%20file.txt')).toBe('/tmp/a file.txt')
    expect(fileUrlToPath('file://localhost/tmp/x')).toBe('/tmp/x')
  })

  it('refuses anything that is not a local file', () => {
    expect(fileUrlToPath('https://example.com/a')).toBeNull()
    expect(fileUrlToPath('file://otherhost/tmp/x')).toBeNull()
    expect(fileUrlToPath('not a url')).toBeNull()
  })

  it('reads every file from a uri-list, skipping comments and blanks', () => {
    const list = '# copied\r\nfile:///tmp/a.txt\r\n\r\nfile:///tmp/b%20c.png\r\nhttps://x.y/z\r\n'
    expect(parseUriList(list)).toEqual(['/tmp/a.txt', '/tmp/b c.png'])
  })
})

describe('safeEntryName', () => {
  it('keeps the last segment', () => {
    expect(safeEntryName('report.pdf')).toBe('report.pdf')
    expect(safeEntryName('/Users/me/report.pdf')).toBe('report.pdf')
  })

  it('refuses names that could escape the target directory', () => {
    expect(safeEntryName('')).toBeNull()
    expect(safeEntryName('..')).toBeNull()
    expect(safeEntryName('.')).toBeNull()
  })
})
