import { describe, expect, it } from 'vitest'
import { terminalKeyAction } from './clipboard-keys'
import type { KeyLike } from './clipboard-keys'

function key(partial: Partial<KeyLike> & { key: string }): KeyLike {
  return {
    type: 'keydown',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    ...partial
  }
}

const MAC = { isMac: true, hasSelection: true }
const PC = { isMac: false, hasSelection: true }

describe('terminalKeyAction on macOS', () => {
  it('copies with ⌘C when text is selected', () => {
    expect(terminalKeyAction(key({ key: 'c', metaKey: true }), MAC)).toBe('copy')
    expect(terminalKeyAction(key({ key: 'C', metaKey: true }), MAC)).toBe('copy')
  })

  it('forwards ⌘C when nothing is selected', () => {
    expect(
      terminalKeyAction(key({ key: 'c', metaKey: true }), { isMac: true, hasSelection: false })
    ).toBe('pass')
  })

  it('never touches Ctrl+C — that is the agent interrupt', () => {
    expect(terminalKeyAction(key({ key: 'c', ctrlKey: true }), MAC)).toBe('pass')
    expect(terminalKeyAction(key({ key: 'c', ctrlKey: true, metaKey: true }), MAC)).toBe('pass')
  })

  it('selects all with ⌘A', () => {
    expect(terminalKeyAction(key({ key: 'a', metaKey: true }), MAC)).toBe('select-all')
  })

  it('pastes with ⌘V whether or not anything is selected', () => {
    expect(terminalKeyAction(key({ key: 'v', metaKey: true }), MAC)).toBe('paste')
    expect(
      terminalKeyAction(key({ key: 'v', metaKey: true }), { isMac: true, hasSelection: false })
    ).toBe('paste')
  })
})

describe('terminalKeyAction elsewhere', () => {
  it('copies only with Ctrl+Shift+C', () => {
    expect(terminalKeyAction(key({ key: 'c', ctrlKey: true, shiftKey: true }), PC)).toBe('copy')
  })

  it('leaves plain Ctrl+C as SIGINT even with a selection', () => {
    expect(terminalKeyAction(key({ key: 'c', ctrlKey: true }), PC)).toBe('pass')
  })

  it('does not claim Ctrl+A (readline start-of-line)', () => {
    expect(terminalKeyAction(key({ key: 'a', ctrlKey: true }), PC)).toBe('pass')
  })

  it('pastes only with Ctrl+Shift+V, leaving Ctrl+V literal', () => {
    expect(terminalKeyAction(key({ key: 'v', ctrlKey: true, shiftKey: true }), PC)).toBe('paste')
    expect(terminalKeyAction(key({ key: 'v', ctrlKey: true }), PC)).toBe('pass')
  })
})

describe('terminalKeyAction in general', () => {
  it('ignores everything that is not a modified keydown', () => {
    expect(terminalKeyAction(key({ key: 'c', metaKey: true, type: 'keyup' }), MAC)).toBe('pass')
    expect(terminalKeyAction(key({ key: 'c' }), MAC)).toBe('pass')
    expect(terminalKeyAction(key({ key: 'v' }), MAC)).toBe('pass')
    expect(terminalKeyAction(key({ key: 'x', metaKey: true }), MAC)).toBe('pass')
  })
})
