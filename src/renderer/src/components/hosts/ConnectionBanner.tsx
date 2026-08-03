import { useConnectionStore } from '@/stores/connection'

/** Amber/red strip under the titlebar while the active host is reconnecting or failed. */
export default function ConnectionBanner(): React.JSX.Element | null {
  const activeHostId = useConnectionStore((s) => s.activeHostId)
  const hosts = useConnectionStore((s) => s.hosts)
  const ev = useConnectionStore((s) => (s.activeHostId ? s.statusByHost[s.activeHostId] : undefined))
  const connect = useConnectionStore((s) => s.connect)

  if (!activeHostId || !ev) return null
  if (ev.status !== 'reconnecting' && ev.status !== 'failed') return null

  const label = hosts.find((h) => h.id === activeHostId)?.label ?? activeHostId
  const failed = ev.status === 'failed'
  const message = failed
    ? `Connection to ${label} failed${ev.error ? `: ${ev.error}` : ''}`
    : `Reconnecting to ${label}${ev.attempt ? ` (attempt ${ev.attempt})` : ''}…`

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '6px 14px',
        fontSize: 12.5,
        flexShrink: 0,
        background: failed ? 'rgba(229, 99, 110, 0.12)' : 'rgba(217, 166, 63, 0.12)',
        borderBottom: `1px solid ${failed ? 'var(--ra-red)' : 'var(--ra-yellow)'}`,
        color: failed ? 'var(--ra-red)' : 'var(--ra-yellow)'
      }}
    >
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {message}
      </span>
      <button
        className='ra-btn'
        style={{ padding: '2px 10px', fontSize: 12 }}
        onClick={() => void connect(activeHostId)}
      >
        Retry now
      </button>
    </div>
  )
}
