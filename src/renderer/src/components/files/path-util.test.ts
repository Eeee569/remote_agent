import { describe, expect, it } from 'vitest'
import { basenameOf, dirnameOf, isInside, joinPath, validName } from './path-util'

describe('dirnameOf', () => {
  it('returns the parent directory', () => {
    expect(dirnameOf('/home/u/repo/src/index.ts')).toBe('/home/u/repo/src')
    expect(dirnameOf('/home/u/repo/src/')).toBe('/home/u/repo')
  })

  it('stops at the root', () => {
    expect(dirnameOf('/top')).toBe('/')
    expect(dirnameOf('/')).toBe('/')
  })
})

describe('basenameOf', () => {
  it('returns the last segment, ignoring trailing slashes', () => {
    expect(basenameOf('/a/b/c.txt')).toBe('c.txt')
    expect(basenameOf('/a/b/')).toBe('b')
  })
})

describe('joinPath', () => {
  it('joins without doubling separators', () => {
    expect(joinPath('/a/b', 'c.txt')).toBe('/a/b/c.txt')
    expect(joinPath('/a/b/', 'c.txt')).toBe('/a/b/c.txt')
    expect(joinPath('/', 'c.txt')).toBe('/c.txt')
  })
})

describe('isInside', () => {
  it('matches the directory itself and its descendants', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/b', '/a/b/c/d.txt')).toBe(true)
    expect(isInside('/a/b/', '/a/b/c')).toBe(true)
  })

  it('does not match siblings that share a prefix', () => {
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/a/b', '/a')).toBe(false)
    expect(isInside('/a/b', '/x/y')).toBe(false)
  })
})

describe('validName', () => {
  it('accepts a single trimmed segment', () => {
    expect(validName('notes.md')).toBe('notes.md')
    expect(validName('  notes.md  ')).toBe('notes.md')
    expect(validName('.gitignore')).toBe('.gitignore')
  })

  it('rejects anything that could escape the directory', () => {
    expect(validName('')).toBeNull()
    expect(validName('   ')).toBeNull()
    expect(validName('.')).toBeNull()
    expect(validName('..')).toBeNull()
    expect(validName('a/b')).toBeNull()
    expect(validName('/abs')).toBeNull()
    expect(validName('../escape')).toBeNull()
  })
})
