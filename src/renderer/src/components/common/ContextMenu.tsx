import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export type MenuEntry =
  | { kind: 'header'; label: string }
  | { kind: 'separator' }
  | {
      kind: 'item'
      label: string
      /** leading glyph column: a check, an icon, or blank to keep labels aligned */
      icon?: string
      title?: string
      danger?: boolean
      dim?: boolean
      disabled?: boolean
      onClick(): void
    }

export interface ContextMenuProps {
  /** viewport coordinates of the click that opened the menu */
  x: number
  y: number
  entries: MenuEntry[]
  width?: number
  /**
   * Elements matching this selector do not dismiss the menu on mousedown, so
   * a toggle button can close it via its own click handler instead of being
   * dismissed first and immediately reopened.
   */
  ignoreSelector?: string
  onDismiss(): void
}

const MARGIN = 6

/**
 * Small fixed-position popup menu. Fixed positioning keeps it out of the
 * scroll/overflow containers it is opened from, and it flips back inside the
 * viewport once its real size is known.
 */
export default function ContextMenu(props: ContextMenuProps): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState({ x: props.x, y: props.y })
  const dismissRef = useRef(props.onDismiss)
  dismissRef.current = props.onDismiss
  const ignoreRef = useRef(props.ignoreSelector)
  ignoreRef.current = props.ignoreSelector

  // clamp into the viewport once the real size is known; only ever writes a
  // different position, so it settles after one extra layout pass
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const next = {
      x: Math.max(MARGIN, Math.min(props.x, window.innerWidth - width - MARGIN)),
      y: Math.max(MARGIN, Math.min(props.y, window.innerHeight - height - MARGIN))
    }
    setPos((cur) => (cur.x === next.x && cur.y === next.y ? cur : next))
  }, [props.x, props.y])

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Element | null
      if (ref.current?.contains(target as Node)) return
      const ignore = ignoreRef.current
      if (ignore !== undefined && target?.closest(ignore)) return
      dismissRef.current()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') dismissRef.current()
    }
    const onResize = (): void => dismissRef.current()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  return (
    <div
      ref={ref}
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: 'fixed',
        top: pos.y,
        left: pos.x,
        zIndex: 900,
        width: props.width ?? 210,
        padding: '4px 0',
        background: 'var(--ra-bg-raised)',
        border: '1px solid var(--ra-border-strong)',
        borderRadius: 6,
        boxShadow: '0 10px 28px rgba(0, 0, 0, 0.5)'
      }}
    >
      {props.entries.map((entry, i) => {
        if (entry.kind === 'separator') {
          return (
            <div
              key={`sep-${i}`}
              style={{ height: 1, background: 'var(--ra-border)', margin: '4px 0' }}
            />
          )
        }
        if (entry.kind === 'header') {
          return (
            <div
              key={`head-${i}`}
              style={{
                padding: '4px 10px 6px',
                fontSize: 10.5,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
                color: 'var(--ra-text-faint)'
              }}
            >
              {entry.label}
            </div>
          )
        }
        const color = entry.disabled
          ? 'var(--ra-text-faint)'
          : entry.danger
            ? 'var(--ra-red)'
            : entry.dim
              ? 'var(--ra-text-dim)'
              : 'var(--ra-text)'
        return (
          <div
            key={`${entry.label}-${i}`}
            title={entry.title}
            onClick={() => {
              if (entry.disabled) return
              entry.onClick()
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '5px 10px',
              fontSize: 12,
              whiteSpace: 'nowrap',
              cursor: entry.disabled ? 'default' : 'pointer',
              color
            }}
            onMouseEnter={(e) => {
              if (!entry.disabled) e.currentTarget.style.background = 'var(--ra-bg-hover)'
            }}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            <span style={{ width: 12, flexShrink: 0, color: 'var(--ra-accent)' }}>
              {entry.icon ?? ''}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{entry.label}</span>
          </div>
        )
      })}
    </div>
  )
}
