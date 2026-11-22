import { describe, expect, it } from 'vitest'
import { contentDisposition, downloadUrlData, localFileMode } from './download-util'

describe('downloadUrlData', () => {
  it('is mime:name:url', () => {
    expect(downloadUrlData('a.txt', 'http://127.0.0.1:5/x')).toBe(
      'application/octet-stream:a.txt:http://127.0.0.1:5/x'
    )
  })

  it('keeps a colon in the name from ending the field', () => {
    expect(downloadUrlData('10:30 notes.md', 'http://h/x')).toBe(
      'application/octet-stream:10_30 notes.md:http://h/x'
    )
  })
})

describe('contentDisposition', () => {
  it('quotes plain names', () => {
    expect(contentDisposition('report.pdf')).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`
    )
  })

  it('escapes quotes and non-ASCII', () => {
    expect(contentDisposition('é "q".txt')).toBe(
      `attachment; filename="_ _q_.txt"; filename*=UTF-8''%C3%A9%20%22q%22.txt`
    )
  })
})

describe('localFileMode', () => {
  it('keeps the executable bit', () => {
    expect(localFileMode(0o100755)).toBe(0o755)
  })

  it('always leaves the file readable and writable by its owner', () => {
    expect(localFileMode(0o100000)).toBe(0o600)
    expect(localFileMode(0o100444)).toBe(0o644)
  })
})
