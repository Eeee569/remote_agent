/**
 * The four "type a name" prompts the file tree raises. Kept pure (no React,
 * no api calls) so the wording, prefilled value, selection, and validation
 * rules can be unit tested.
 */
import { basenameOf, validName } from '@/components/files/path-util'

export interface PromptSpec {
  title: string
  label: string
  initialValue: string
  confirmLabel: string
  placeholder?: string
  /** how much of the prefilled value to preselect */
  selectTo?: number
  validate(value: string): string | null
}

const NAME_ERROR = 'Enter a single name — no “/”, “.” or “..”.'

function nameValidator(existing?: readonly string[]): (value: string) => string | null {
  return (value) => {
    const name = validName(value)
    if (name === null) return NAME_ERROR
    if (existing?.includes(name) === true) return `“${name}” already exists here.`
    return null
  }
}

/** Length of the file stem, so renaming preselects the name but not ".ts". */
export function stemLength(name: string): number {
  const at = name.lastIndexOf('.')
  return at > 0 ? at : name.length
}

export function newFileSpec(dir: string, siblings?: readonly string[]): PromptSpec {
  return {
    title: 'New file',
    label: `Create in ${dir}`,
    initialValue: '',
    confirmLabel: 'Create file',
    placeholder: 'notes.md',
    validate: nameValidator(siblings)
  }
}

export function newFolderSpec(dir: string, siblings?: readonly string[]): PromptSpec {
  return {
    title: 'New folder',
    label: `Create in ${dir}`,
    initialValue: '',
    confirmLabel: 'Create folder',
    placeholder: 'src',
    validate: nameValidator(siblings)
  }
}

export function renameSpec(path: string, siblings?: readonly string[]): PromptSpec {
  const name = basenameOf(path)
  return {
    title: 'Rename',
    label: `Rename “${name}” to`,
    initialValue: name,
    confirmLabel: 'Rename',
    selectTo: stemLength(name),
    validate: (value) => {
      if (value.trim() === name) return null // no-op rename is allowed
      return nameValidator(siblings)(value)
    }
  }
}

export function moveSpec(path: string): PromptSpec {
  return {
    title: 'Move',
    label: `Move “${basenameOf(path)}” to (full path on the server)`,
    initialValue: path,
    confirmLabel: 'Move',
    selectTo: 0,
    validate: (value) => {
      const dest = value.trim()
      if (dest === '') return 'Enter a destination path.'
      if (!dest.startsWith('/')) return 'Enter an absolute path, starting with “/”.'
      if (dest.replace(/\/+$/, '') === path.replace(/\/+$/, '')) return null // no-op
      return null
    }
  }
}
