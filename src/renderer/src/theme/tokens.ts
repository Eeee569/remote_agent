/**
 * Reads the theme tokens defined in theme/dark.css so the xterm and Monaco
 * themes stay in step with the CSS chrome instead of repeating hex values.
 * Values are resolved on demand (the stylesheet is loaded before any panel
 * mounts) and cached, since they never change at runtime.
 */

const cache = new Map<string, string>()

/** Value of a `--ra-*` custom property, or `fallback` when it is unset. */
export function token(name: string, fallback: string): string {
  const cached = cache.get(name)
  if (cached !== undefined) return cached
  let value = ''
  try {
    value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  } catch {
    value = '' // no document (tests, worker) — fall through to the fallback
  }
  const resolved = value === '' ? fallback : value
  cache.set(name, resolved)
  return resolved
}

/** Editor/terminal surface colour; also the window's own background. */
export const terminalBackground = (): string => token('--ra-term-bg', '#272822')

/** xterm.js ITheme built from the CSS tokens. */
export function xtermTheme(): Record<string, string> {
  return {
    background: terminalBackground(),
    foreground: token('--ra-term-fg', '#f8f8f2'),
    cursor: token('--ra-term-cursor', '#f8f8f0'),
    selectionBackground: token('--ra-term-selection', 'rgba(73, 72, 62, 0.99)'),
    black: token('--ra-ansi-black', '#272822'),
    red: token('--ra-ansi-red', '#f92672'),
    green: token('--ra-ansi-green', '#a6e22e'),
    yellow: token('--ra-ansi-yellow', '#f4bf75'),
    blue: token('--ra-ansi-blue', '#66d9ef'),
    magenta: token('--ra-ansi-magenta', '#ae81ff'),
    cyan: token('--ra-ansi-cyan', '#a1efe4'),
    white: token('--ra-ansi-white', '#f8f8f2'),
    brightBlack: token('--ra-ansi-bright-black', '#75715e'),
    brightRed: token('--ra-ansi-bright-red', '#fd5f8f'),
    brightGreen: token('--ra-ansi-bright-green', '#c1f161'),
    brightYellow: token('--ra-ansi-bright-yellow', '#fdd992'),
    brightBlue: token('--ra-ansi-bright-blue', '#8ee6f5'),
    brightMagenta: token('--ra-ansi-bright-magenta', '#c9a7ff'),
    brightCyan: token('--ra-ansi-bright-cyan', '#bdf5ee'),
    brightWhite: token('--ra-ansi-bright-white', '#f9f8f5')
  }
}

/**
 * Colour overrides for Monaco's "ra-dark" theme. Syntax colours come from the
 * inherited `vs-dark` base — the same token colours the editor screenshot
 * shows — so only the chrome is restated here, from our tokens.
 */
export function monacoColors(): Record<string, string> {
  return {
    'editor.background': token('--ra-bg-panel', '#1f1f1f'),
    'editor.foreground': token('--ra-text', '#cccccc'),
    'editorLineNumber.foreground': '#6e7681',
    'editorLineNumber.activeForeground': token('--ra-text', '#cccccc'),
    'editor.lineHighlightBackground': '#282828',
    'editor.selectionBackground': '#264f78',
    'editor.inactiveSelectionBackground': '#3a3d41',
    'editorCursor.foreground': token('--ra-term-cursor', '#cccccc'),
    'editorIndentGuide.background1': token('--ra-border', '#2b2b2b'),
    'editorWidget.background': '#202020',
    'editorWidget.border': token('--ra-border-strong', '#3c3c3c'),
    'input.background': token('--ra-input-bg', '#313131'),
    'scrollbarSlider.background': 'rgba(121, 121, 121, 0.4)',
    'scrollbarSlider.hoverBackground': 'rgba(100, 100, 100, 0.7)',
    focusBorder: token('--ra-accent-strong', '#0078d4')
  }
}
