import { useEffect, useState } from 'react'
import { api } from './api'

/** M0 shell — replaced by the full app (host picker, project tabs, dock workspace). */
export default function App(): React.JSX.Element {
  const [pong, setPong] = useState<string>('…')
  useEffect(() => {
    api.ping().then(setPong)
  }, [])
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontWeight: 600, letterSpacing: '-0.02em' }}>Remote Agent</h1>
        <p style={{ color: 'var(--ra-text-dim)' }}>IPC bridge: {pong}</p>
      </div>
    </div>
  )
}
