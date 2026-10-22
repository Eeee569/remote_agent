import { describe, expect, it } from 'vitest'
import { hasPdfHeader, isPdfPath } from './pdf'

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)

describe('isPdfPath', () => {
  it('matches the .pdf extension in any case', () => {
    expect(isPdfPath('/home/u/paper.pdf')).toBe(true)
    expect(isPdfPath('/home/u/SCAN.PDF')).toBe(true)
  })

  it('ignores other files, including ones that merely mention pdf', () => {
    expect(isPdfPath('/home/u/pdf')).toBe(false)
    expect(isPdfPath('/home/u/paper.pdf.txt')).toBe(false)
    expect(isPdfPath('/home/u/pdf-notes.md')).toBe(false)
  })
})

describe('hasPdfHeader', () => {
  it('accepts a header at the start', () => {
    expect(hasPdfHeader(bytes('%PDF-1.7\n...'))).toBe(true)
  })

  it('accepts a header after leading junk within the first KiB', () => {
    expect(hasPdfHeader(bytes('\uFEFFjunk%PDF-1.4'))).toBe(true)
  })

  it('rejects files without one', () => {
    expect(hasPdfHeader(bytes('hello world'))).toBe(false)
    expect(hasPdfHeader(new Uint8Array())).toBe(false)
    expect(hasPdfHeader(bytes('%PDF'))).toBe(false)
  })

  it('does not look past the first KiB', () => {
    expect(hasPdfHeader(bytes('x'.repeat(2000) + '%PDF-1.4'))).toBe(false)
  })
})
