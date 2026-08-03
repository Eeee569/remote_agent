import { useConnectionStore } from '@/stores/connection'
import { useUiStore } from '@/stores/ui'
import type { ConnStatus } from '@shared/domain'

const MANAGE_VALUE = '__manage__'

const DOT_COLOR: Record<ConnStatus, string> = {
  idle: 'var(--ra-text-faint)',
  connecting: 'var(--ra-yellow)',
  reconnecting: 'var(--ra-yellow)',
  connected: 'var(--ra-green)',
  failed: 'var(--ra-red)'
}

export default function HostPicker(): React.JSX.Element {
  const hosts = useConnectionStore((s) => s.hosts)
  const activeHostId = useConnectionStore((s) => s.activeHostId)
  const statusByHost = useConnectionStore((s) => s.statusByHost)
  const setActiveHost = useConnectionStore((s) => s.setActiveHost)
  const connect = useConnectionStore((s) => s.connect)
  const disconnect = useConnectionStore((s) => s.disconnect)
  const openHostManager = useUiStore((s) => s.openHostManager)

  const status: ConnStatus = activeHostId
    ? (statusByHost[activeHostId]?.status ?? 'idle')
    : 'idle'
  const busyOrUp = status === 'connected' || status === 'connecting' || status === 'reconnecting'
  const pulsing = status === 'connecting' || status === 'reconnecting'

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span
        title={status}
        style={{
          width: 9,
          height: 9,
          borderRadius: '50%',
          flexShrink: 0,
          background: DOT_COLOR[status],
          animation: pulsing ? 'ra-pulse 1.2s ease-in-out infinite' : 'none'
        }}
      />
      <select
        className='ra-input'
        style={{ padding: '3px 6px', fontSize: 12, maxWidth: 220 }}
        value={activeHostId ?? ''}
        onChange={(e) => {
          const v = e.target.value
          if (v === MANAGE_VALUE) {
            openHostManager()
            return
          }
          setActiveHost(v === '' ? null : v)
        }}
      >
        {hosts.length === 0 && <option value=''>No hosts</option>}
        {hosts.length > 0 && activeHostId === null && (
          <option value='' disabled>
            Select host…
          </option>
        )}
        {hosts.map((h) => (
          <option key={h.id} value={h.id}>
            {h.label}
          </option>
        ))}
        <option value={MANAGE_VALUE}>Manage hosts…</option>
      </select>
      <button
        className='ra-btn'
        style={{ padding: '3px 10px', fontSize: 12 }}
        disabled={!activeHostId || status === 'connecting'}
        onClick={() => {
          if (!activeHostId) return
          if (busyOrUp) void disconnect(activeHostId)
          else void connect(activeHostId)
        }}
      >
        {status === 'connecting' ? 'Connecting…' : busyOrUp ? 'Disconnect' : 'Connect'}
      </button>
    </div>
  )
}
