import { useEffect, useState } from 'react'
import type { IDockviewPanelProps } from 'dockview'
import { shellTmuxName } from '@shared/helper-protocol'
import type { SessionPanelParams } from '@/components/dock/panels'
import { sessionFrameStyle } from '@/components/dock/session-layout'
import { useProjectsStore } from '@/stores/projects'
import XtermView from '@/components/terminal/XtermView'

/**
 * A plain login shell on the server, in the session's working directory —
 * for git, tests, and log tailing next to the agent. It lives in its own
 * tmux session ("<session>-shell", created on first attach) so it survives
 * disconnects and app restarts just like the agent, and is killed with the
 * session.
 */
const ShellPanel: React.FC<IDockviewPanelProps<SessionPanelParams>> = (props) => {
  const { sessionId, hostId, projectId } = props.params
  const session = useProjectsStore((s) =>
    (s.sessionsByProject[projectId] ?? []).find((x) => x.id === sessionId)
  )
  const [attached, setAttached] = useState(true)
  /*
   * Every attached terminal holds an SSH channel, and sshd caps them
   * (MaxSessions). The companion shell is a secondary tab, so it stays
   * unopened until it is first looked at — then it keeps its channel, so
   * switching tabs never drops the shell you are working in.
   */
  const [everShown, setEverShown] = useState(() => props.api.isVisible)

  useEffect(() => {
    if (everShown) return
    const sub = props.api.onDidVisibilityChange((e) => {
      if (e.isVisible) setEverShown(true)
    })
    return () => sub.dispose()
  }, [everShown, props.api])

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

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        ...sessionFrameStyle(sessionId)
      }}
    >
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
        <span style={{ color: 'var(--ra-text-faint)', fontFamily: 'var(--ra-mono)', fontSize: 12 }}>
          $
        </span>
        <span
          title={session.cwd}
          style={{
            fontFamily: 'var(--ra-mono)',
            fontSize: 12,
            color: 'var(--ra-text-dim)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {session.cwd}
        </span>
        <div style={{ flex: 1 }} />
        <button
          className='ra-btn'
          style={{ padding: '2px 9px', fontSize: 11.5 }}
          title={
            attached
              ? 'Close the terminal channel; the shell keeps running on the server'
              : 'Reattach to the shell'
          }
          onClick={() => setAttached((v) => !v)}
        >
          {attached ? 'Detach' : 'Attach'}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {attached && everShown ? (
          <XtermView
            hostId={hostId}
            tmuxName={shellTmuxName(session.tmuxName)}
            cwd={session.cwd}
          />
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
            {attached
              ? 'Opening the shell…'
              : 'Detached — the shell keeps running on the server.'}
          </div>
        )}
      </div>
    </div>
  )
}

export default ShellPanel
