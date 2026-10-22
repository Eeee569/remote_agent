/**
 * Inline SVG icons for the file tree. Drawn on a 16x16 grid with `currentColor`
 * so a row's colour drives the glyph, and kept flat/geometric to sit well next
 * to monospaced names.
 */

const BASE: React.CSSProperties = { flexShrink: 0, display: 'block' }

export function ChevronIcon(props: { open: boolean }): React.JSX.Element {
  return (
    <svg
      width='10'
      height='10'
      viewBox='0 0 16 16'
      style={{
        ...BASE,
        transition: 'transform 0.12s ease',
        transform: props.open ? 'rotate(90deg)' : 'none'
      }}
      aria-hidden='true'
    >
      <path
        d='M6 3.5l5 4.5-5 4.5'
        fill='none'
        stroke='currentColor'
        strokeWidth='1.6'
        strokeLinecap='round'
        strokeLinejoin='round'
      />
    </svg>
  )
}

export function FolderIcon(props: { open: boolean; color: string }): React.JSX.Element {
  return (
    <svg width='14' height='14' viewBox='0 0 16 16' style={BASE} aria-hidden='true'>
      {props.open ? (
        <>
          <path
            d='M1.5 12.2V4.2c0-.66.54-1.2 1.2-1.2h3.1c.32 0 .62.12.85.35l.9.9c.22.22.53.35.85.35h3.35c.66 0 1.2.54 1.2 1.2v1.05H4.6c-.53 0-1 .34-1.15.85L1.5 12.2z'
            fill={props.color}
            opacity='0.75'
          />
          <path
            d='M4.35 7.85h10.2c.4 0 .69.39.57.78l-1.2 3.95c-.16.5-.62.85-1.15.85H2.35c-.4 0-.69-.39-.57-.78l1.42-4.05c.16-.45.6-.75 1.15-.75z'
            fill={props.color}
          />
        </>
      ) : (
        <path
          d='M1.5 4.2c0-.66.54-1.2 1.2-1.2h3.1c.32 0 .62.12.85.35l.9.9c.22.22.53.35.85.35h4.9c.66 0 1.2.54 1.2 1.2v6c0 .66-.54 1.2-1.2 1.2H2.7c-.66 0-1.2-.54-1.2-1.2V4.2z'
          fill={props.color}
        />
      )}
    </svg>
  )
}

export function FileIcon(props: { color: string }): React.JSX.Element {
  return (
    <svg width='14' height='14' viewBox='0 0 16 16' style={BASE} aria-hidden='true'>
      <path
        d='M3.5 2.6c0-.61.5-1.1 1.1-1.1h4.06c.29 0 .57.12.78.33l3.14 3.14c.21.21.32.49.32.78v7.65c0 .61-.5 1.1-1.1 1.1H4.6c-.6 0-1.1-.49-1.1-1.1V2.6z'
        fill={props.color}
        opacity='0.9'
      />
      <path d='M8.9 1.7v3.1c0 .5.4.9.9.9h3.05' fill='var(--ra-bg-side)' opacity='0.55' />
    </svg>
  )
}

/** Small arrow badge overlaid on the icon a symlink points at. */
export function SymlinkBadge(): React.JSX.Element {
  return (
    <svg
      width='8'
      height='8'
      viewBox='0 0 16 16'
      style={{ position: 'absolute', right: -2, bottom: -2 }}
      aria-hidden='true'
    >
      <circle cx='8' cy='8' r='7.5' fill='var(--ra-bg-side)' />
      <path
        d='M5.5 10.5l5-5M6.8 5.2h3.9v3.9'
        fill='none'
        stroke='var(--ra-accent)'
        strokeWidth='1.8'
        strokeLinecap='round'
        strokeLinejoin='round'
      />
    </svg>
  )
}

// ---------------- per-type colouring ----------------

const CODE = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rs',
  'go',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'rb',
  'php',
  'swift',
  'sh',
  'bash',
  'zsh',
  'sql'
])
const DATA = new Set(['json', 'yaml', 'yml', 'toml', 'ini', 'xml', 'env', 'lock', 'conf', 'cfg'])
const DOCS = new Set(['md', 'markdown', 'txt', 'rst', 'adoc', 'pdf'])
const WEB = new Set(['html', 'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte'])
const MEDIA = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'mp4', 'mp3', 'woff2'])

/**
 * Per-extension tint, drawn from the muted `--ra-icon-*` tokens: enough to
 * tell kinds apart at a glance, quiet enough that the git decoration colours
 * on the filenames stay the loudest thing in the tree.
 */
export function fileIconColor(name: string): string {
  const at = name.lastIndexOf('.')
  const ext = at > 0 ? name.slice(at + 1).toLowerCase() : ''
  if (CODE.has(ext)) return 'var(--ra-icon-code)'
  if (DATA.has(ext)) return 'var(--ra-icon-data)'
  if (WEB.has(ext)) return 'var(--ra-icon-markup)'
  if (MEDIA.has(ext)) return 'var(--ra-icon-media)'
  if (DOCS.has(ext)) return 'var(--ra-icon-doc)'
  return 'var(--ra-icon-plain)'
}
