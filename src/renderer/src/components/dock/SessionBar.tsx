import { useState } from 'react'
import type { AgentKind, SessionLayoutMode, SessionMeta } from '@shared/domain'
import ContextMenu from '@/components/common/ContextMenu'
import type { MenuEntry } from '@/components/common/ContextMenu'
import { SESSION_PANEL_KINDS, panelId, sessionAccent } from '@/components/dock/session-layout'
import type { SessionPanelKind } from '@/components/dock/session-layout'
import { useUiStore } from '@/stores/ui'

const AGENT_LABEL: Record<AgentKind, string> = {
  claude: 'claude',
  codex: 'codex',
  shell: 'sh'
}

const PANEL_LABEL: Record<SessionPanelKind, string> = {
  term: 'Terminal',
  shell: 'Shell',
  tree: 'Files',
  view: 'Viewer'
}

const MODES: Array<{ value: SessionLayoutMode; label: string; title: string }> = [
  {
    value: 'focus',
    label: 'Focus',
    title: 'One session at a time — terminal, shell, files, and viewer of the session picked here'
  },
  { value: 'columns', label: 'Columns', title: 'Every session side by side, one column each' },
  { value: 'rows', label: 'Rows', title: 'Every session stacked, one row each' },
  { value: 'grid', label: 'Grid', title: 'Every session in its own cell of a grid' }
]

const ANCHOR_ATTR = 'data-ra-session-menu'

export interface SessionBarProps {
  sessions: SessionMeta[]
  /** closed panel ids; a closed "term:<id>" means the session is hidden */
  closed: ReadonlySet<string>
  mode: SessionLayoutMode
  focusedSessionId: string | null
  onSelect(sessionId: string): void
  onTogglePanel(sessionId: string, kind: SessionPanelKind): void
  onCloseSession(sessionId: string): void
  onKillSession(sessionId: string): void
  onArrangeSession(sessionId: string, layout: 'split' | 'tabs'): void
  onModeChange(mode: SessionLayoutMode): void
}

interface MenuAnchor {
  sessionId: string
  x: number
  y: number
}

/**
 * Strip above the dock listing the project's sessions and how they are laid
 * out. In focus mode the chips act as tabs — one session on screen at a time.
 * Hidden sessions (panels closed, tmux still running) stay listed so they can
 * be brought back, and each chip's menu reopens individual panels.
 */
export default function SessionBar(props: SessionBarProps): React.JSX.Element | null {
  const openNewSession = useUiStore((s) => s.openNewSession)
  const [menu, setMenu] = useState<MenuAnchor | null>(null)
  const menuSession = menu ? props.sessions.find((s) => s.id === menu.sessionId) : undefined

  if (props.sessions.length === 0) return null

  /** Everything you can do to a session, from its caret or a right-click. */
  const entriesFor = (session: SessionMeta): MenuEntry[] => {
    const run = (fn: () => void): (() => void) => () => {
      setMenu(null)
      fn()
    }
    return [
      { kind: 'header', label: 'Panels' },
      ...SESSION_PANEL_KINDS.map((kind): MenuEntry => {
        const open = !props.closed.has(panelId(kind, session.id))
        return {
          kind: 'item',
          icon: open ? '✓' : '',
          label: PANEL_LABEL[kind],
          dim: !open,
          title: open
            ? `Close the ${PANEL_LABEL[kind]} panel`
            : `Reopen the ${PANEL_LABEL[kind]} panel`,
          onClick: run(() => props.onTogglePanel(session.id, kind))
        }
      }),
      { kind: 'separator' },
      {
        kind: 'item',
        icon: '⊞',
        label: 'Split panels apart',
        title: 'Show this session’s files and viewer beside its terminal, inside its own tile',
        onClick: run(() => props.onArrangeSession(session.id, 'split'))
      },
      {
        kind: 'item',
        icon: '⊟',
        label: 'Show panels as tabs',
        title: 'Put this session’s panels back together as tabs',
        onClick: run(() => props.onArrangeSession(session.id, 'tabs'))
      },
      { kind: 'separator' },
      {
        kind: 'item',
        icon: '×',
        label: 'Close',
        dim: true,
        title: 'Close every panel of this session; tmux keeps running on the server',
        onClick: run(() => props.onCloseSession(session.id))
      },
      {
        kind: 'item',
        icon: '⏻',
        label: 'Kill session…',
        danger: true,
        title: 'Stop the tmux session and the agent running in it',
        onClick: run(() => props.onKillSession(session.id))
      }
    ]
  }

  return (
    <div
      style={{
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: 30,
        padding: '0 8px',
        background: 'var(--ra-bg-raised)',
        borderBottom: '1px solid var(--ra-border)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, overflowX: 'auto', flex: 1 }}>
        {props.sessions.map((s) => {
          const hidden = props.closed.has(panelId('term', s.id))
          const current = props.mode === 'focus' && props.focusedSessionId === s.id && !hidden
          const accent = sessionAccent(s.id)
          const missing = SESSION_PANEL_KINDS.filter((k) => props.closed.has(panelId(k, s.id)))
          return (
            <div
              key={s.id}
              title={
                hidden
                  ? `${s.tmuxName} — panels closed, tmux still running. Click to reopen.`
                  : `${s.tmuxName} — ${s.cwd}`
              }
              onClick={() => props.onSelect(s.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ sessionId: s.id, x: e.clientX, y: e.clientY })
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                flexShrink: 0,
                height: 21,
                padding: '0 3px 0 7px',
                cursor: 'pointer',
                borderRadius: 4,
                fontSize: 11.5,
                userSelect: 'none',
                border: `1px ${hidden ? 'dashed' : 'solid'} ${
                  current ? accent : 'var(--ra-border-strong)'
                }`,
                borderLeft: `3px solid ${accent}`,
                background: current
                  ? 'var(--ra-bg-active)'
                  : hidden
                    ? 'transparent'
                    : 'var(--ra-bg-panel)',
                color: hidden ? 'var(--ra-text-faint)' : 'var(--ra-text)',
                opacity: hidden ? 0.7 : 1
              }}
            >
              <span
                title={s.alive === false ? 'tmux session is not running' : undefined}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  flexShrink: 0,
                  background:
                    s.alive === true
                      ? 'var(--ra-green)'
                      : s.alive === false
                        ? 'var(--ra-red)'
                        : 'var(--ra-text-faint)'
                }}
              />
              <span
                style={{
                  fontFamily: 'var(--ra-mono)',
                  maxWidth: 170,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
              >
                {s.tmuxName}
              </span>
              <span style={{ color: 'var(--ra-text-faint)', fontSize: 10 }}>
                {AGENT_LABEL[s.agent]}
              </span>
              <span
                {...{ [ANCHOR_ATTR]: s.id }}
                aria-label={`Panels of ${s.tmuxName}`}
                title={
                  missing.length > 0
                    ? `Closed: ${missing.map((k) => PANEL_LABEL[k]).join(', ')} — click to reopen`
                    : 'Panels of this session'
                }
                onClick={(e) => {
                  e.stopPropagation()
                  const rect = e.currentTarget.getBoundingClientRect()
                  setMenu((cur) =>
                    cur?.sessionId === s.id
                      ? null
                      : { sessionId: s.id, x: rect.left, y: rect.bottom + 6 }
                  )
                }}
                style={{
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                  color: missing.length > 0 && !hidden ? 'var(--ra-yellow)' : 'var(--ra-text-faint)',
                  fontSize: 10,
                  lineHeight: 1,
                  padding: '3px 4px',
                  borderRadius: 3
                }}
              >
                {missing.length > 0 && !hidden && <span>{missing.length}</span>}▾
              </span>
            </div>
          )
        })}
        <button
          className='ra-btn'
          style={{ flexShrink: 0, padding: '1px 8px', fontSize: 11.5 }}
          title='New session in this project'
          onClick={openNewSession}
        >
          +
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        {MODES.map((m, i) => {
          const active = props.mode === m.value
          return (
            <button
              key={m.value}
              className='ra-btn'
              title={m.title}
              onClick={() => props.onModeChange(m.value)}
              style={{
                padding: '1px 9px',
                fontSize: 11.5,
                borderRadius: i === 0 ? '4px 0 0 4px' : i === MODES.length - 1 ? '0 4px 4px 0' : 0,
                marginLeft: i === 0 ? 0 : -1,
                background: active ? 'var(--ra-bg-active)' : 'var(--ra-bg-hover)',
                color: active ? 'var(--ra-text)' : 'var(--ra-text-dim)',
                borderColor: active ? 'var(--ra-accent)' : 'var(--ra-border-strong)',
                position: 'relative',
                zIndex: active ? 1 : 0
              }}
            >
              {m.label}
            </button>
          )
        })}
      </div>

      {menu && menuSession && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={entriesFor(menuSession)}
          ignoreSelector={`[${ANCHOR_ATTR}]`}
          onDismiss={() => setMenu(null)}
        />
      )}
    </div>
  )
}
