import { useState } from 'react'
import type { IDockviewPanelProps } from 'dockview'
import type { AgentKind } from '@shared/domain'
import type { SessionPanelParams } from '@/components/dock/panels'
import { useProjectsStore } from '@/stores/projects'
import XtermView from '@/components/terminal/XtermView'

const AGENT_COLOR: Record<AgentKind, string> = {
  claude: 'var(--ra-purple)',
  codex: 'var(--ra-green)',
  shell: 'var(--ra-text-dim)'
}

const smallBtn: React.CSSProperties = { padding: '2px 9px', fontSize: 11.5 }

const TerminalPanel: React.FC<IDockviewPanelProps<SessionPanelParams>> = (props) => {
  const { sessionId, hostId, projectId } = props.params
  const session = useProjectsStore((s) =>
    (s.sessionsByProject[projectId] ?? []).find((x) => x.id === sessionId)
  )
  const killSession = useProjectsStore((s) => s.killSession)
  const [attached, setAttached] = useState(true)
  const [killing, setKilling] = useState(false)

  if (!session) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--ra-text-dim)',
          fontSize: 12.5
        }}
      >
        Session not found — waiting for server state…
      </div>
    )
  }

  const kill = async (): Promise<void> => {
    if (!window.confirm(`Kill tmux session "${session.tmuxName}"? The agent inside will stop.`)) {
      return
    }
    const alsoRemoveWorktree =
      session.mode === 'worktree'
        ? window.confirm(
            `Also remove the git worktree at ${session.worktree?.path ?? session.cwd}?`
          )
        : false
    setKilling(true)
    try {
      await killSession(hostId, projectId, sessionId, alsoRemoveWorktree)
    } finally {
      setKilling(false)
    }
  }

  const aliveColor =
    session.alive === true
      ? 'var(--ra-green)'
      : session.alive === false
        ? 'var(--ra-red)'
        : 'var(--ra-text-faint)'
  const aliveTitle =
    session.alive === true
      ? 'tmux session is running'
      : session.alive === false
        ? 'tmux session is not running'
        : 'tmux state unknown'

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 8px',
          background: 'var(--ra-bg-raised)',
          borderBottom: '1px solid var(--ra-border)'
        }}
      >
        <span
          title={aliveTitle}
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: aliveColor,
            flexShrink: 0
          }}
        />
        <span
          title={session.cwd}
          style={{
            fontFamily: 'var(--ra-mono)',
            fontSize: 12,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {session.tmuxName}
        </span>
        <span
          style={{
            flexShrink: 0,
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: '0.03em',
            textTransform: 'uppercase',
            color: AGENT_COLOR[session.agent],
            border: `1px solid ${AGENT_COLOR[session.agent]}`,
            borderRadius: 4,
            padding: '0 6px',
            lineHeight: '16px'
          }}
        >
          {session.agent}
        </span>
        <div style={{ flex: 1 }} />
        <button
          className='ra-btn'
          style={smallBtn}
          title={
            attached
              ? 'Close the terminal channel; tmux keeps running on the server'
              : 'Reattach to the tmux session'
          }
          onClick={() => setAttached((v) => !v)}
        >
          {attached ? 'Detach' : 'Attach'}
        </button>
        <button
          className='ra-btn danger'
          style={smallBtn}
          disabled={killing}
          onClick={() => void kill()}
        >
          {killing ? 'Killing…' : 'Kill session'}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {attached ? (
          <XtermView hostId={hostId} tmuxName={session.tmuxName} cwd={session.cwd} />
        ) : (
          <div
            style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--ra-text-dim)',
              fontSize: 12.5
            }}
          >
            Detached — the tmux session keeps running on the server.
          </div>
        )}
      </div>
    </div>
  )
}

export default TerminalPanel
