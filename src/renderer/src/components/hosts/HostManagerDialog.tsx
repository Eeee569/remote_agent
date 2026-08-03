import { useConnectionStore } from '@/stores/connection'
import { useUiStore } from '@/stores/ui'

export default function HostManagerDialog(): React.JSX.Element {
  const hosts = useConnectionStore((s) => s.hosts)
  const deleteHost = useConnectionStore((s) => s.deleteHost)
  const closeHostManager = useUiStore((s) => s.closeHostManager)
  const openHostForm = useUiStore((s) => s.openHostForm)

  return (
    <div
      className='ra-dialog-backdrop'
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeHostManager()
      }}
    >
      <div className='ra-dialog' style={{ width: 560 }}>
        <h2>Hosts</h2>

        {hosts.length === 0 ? (
          <div style={{ color: 'var(--ra-text-dim)', padding: '16px 0' }}>
            No hosts configured yet.
          </div>
        ) : (
          <div
            style={{
              border: '1px solid var(--ra-border)',
              borderRadius: 'var(--ra-radius)',
              overflow: 'hidden'
            }}
          >
            {hosts.map((h, i) => (
              <div
                key={h.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 12px',
                  borderTop: i === 0 ? 'none' : '1px solid var(--ra-border)'
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{h.label}</div>
                  <div
                    style={{
                      color: 'var(--ra-text-dim)',
                      fontSize: 12,
                      fontFamily: 'var(--ra-mono)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {h.username}@{h.host}:{h.port} · {h.authKind === 'key' ? (h.keyPath ?? 'key') : 'ssh-agent'}
                  </div>
                </div>
                <button className='ra-btn' onClick={() => openHostForm(h.id)}>
                  Edit
                </button>
                <button
                  className='ra-btn danger'
                  onClick={() => {
                    if (window.confirm(`Delete host "${h.label}"?`)) void deleteHost(h.id)
                  }}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className='ra-btn primary' onClick={() => openHostForm(null)}>
            Add host
          </button>
          <div style={{ flex: 1 }} />
          <button className='ra-btn' onClick={closeHostManager}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
