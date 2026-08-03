import type { IDockviewPanelProps } from 'dockview'
import type { PlaceholderPanelParams } from '@/components/dock/panels'
import { useUiStore } from '@/stores/ui'

/**
 * Shown in place of a session's panels after the session disappeared
 * (killed elsewhere, tmux server restarted, ...).
 */
const PlaceholderPanel: React.FC<IDockviewPanelProps<PlaceholderPanelParams>> = (props) => {
  const openNewSession = useUiStore((s) => s.openNewSession)
  const title = props.params.title || props.params.sessionId

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16
      }}
    >
      <div style={{ textAlign: 'center', maxWidth: 380 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Session gone</div>
        <p style={{ color: 'var(--ra-text-dim)', margin: '0 0 16px', fontSize: 12.5 }}>
          The session{' '}
          <span style={{ fontFamily: 'var(--ra-mono)', color: 'var(--ra-text)' }}>{title}</span> no
          longer exists on the server.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button className='ra-btn' onClick={() => props.api.close()}>
            Remove panel
          </button>
          <button className='ra-btn primary' onClick={openNewSession}>
            New session
          </button>
        </div>
      </div>
    </div>
  )
}

export default PlaceholderPanel
