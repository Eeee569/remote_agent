import { describe, expect, it } from 'vitest'
import { moveSpec, newFileSpec, newFolderSpec, renameSpec, stemLength } from './prompt-specs'

describe('stemLength', () => {
  it('stops before the extension so a rename preselects the name', () => {
    expect(stemLength('session-layout.ts')).toBe(14)
    expect(stemLength('archive.tar.gz')).toBe(11)
  })

  it('covers the whole name when there is no extension', () => {
    expect(stemLength('LICENSE')).toBe(7)
    expect(stemLength('.gitignore')).toBe(10) // a dotfile is all stem
  })
})

describe('newFileSpec / newFolderSpec', () => {
  it('names the directory being created in and starts empty', () => {
    const spec = newFileSpec('/srv/app/src')
    expect(spec.label).toContain('/srv/app/src')
    expect(spec.initialValue).toBe('')
    expect(spec.confirmLabel).toBe('Create file')
  })

  it('rejects names that could escape the directory', () => {
    const spec = newFolderSpec('/srv/app')
    expect(spec.validate('components')).toBeNull()
    expect(spec.validate('')).not.toBeNull()
    expect(spec.validate('   ')).not.toBeNull()
    expect(spec.validate('..')).not.toBeNull()
    expect(spec.validate('a/b')).not.toBeNull()
    expect(spec.validate('/etc/passwd')).not.toBeNull()
  })

  it('reports a clash with an existing sibling', () => {
    const spec = newFileSpec('/srv/app', ['README.md', 'src'])
    expect(spec.validate('README.md')).toContain('already exists')
    expect(spec.validate('  README.md  ')).toContain('already exists')
    expect(spec.validate('CHANGELOG.md')).toBeNull()
  })
})

describe('renameSpec', () => {
  it('prefills the current name and preselects the stem', () => {
    const spec = renameSpec('/srv/app/src/index.ts')
    expect(spec.initialValue).toBe('index.ts')
    expect(spec.selectTo).toBe(5)
  })

  it('allows keeping the same name, but not colliding with a sibling', () => {
    const spec = renameSpec('/srv/app/a.txt', ['b.txt'])
    expect(spec.validate('a.txt')).toBeNull()
    expect(spec.validate('b.txt')).toContain('already exists')
    expect(spec.validate('c.txt')).toBeNull()
    expect(spec.validate('../c.txt')).not.toBeNull()
  })
})

describe('moveSpec', () => {
  it('prefills the full path with nothing preselected', () => {
    const spec = moveSpec('/srv/app/a.txt')
    expect(spec.initialValue).toBe('/srv/app/a.txt')
    expect(spec.selectTo).toBe(0)
  })

  it('demands an absolute destination', () => {
    const spec = moveSpec('/srv/app/a.txt')
    expect(spec.validate('/srv/other/a.txt')).toBeNull()
    expect(spec.validate('')).toContain('destination')
    expect(spec.validate('relative/a.txt')).toContain('absolute')
  })
})
