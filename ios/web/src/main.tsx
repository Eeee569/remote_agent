import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import './tokens.css'
import './styles.css'
import { HostFormScreen, HostScreen, HostsScreen, SessionScreen } from './screens'
import { errText, loadStore, notify, useApp } from './state'
import { ConfirmHost } from './ui'

/**
 * The on-screen keyboard does not resize the layout viewport in a WKWebView,
 * it covers it. Size the app to the *visual* viewport instead, so the terminal
 * and its key bar always end exactly at the top of the keyboard.
 */
function trackViewport(): void {
  const vv = window.visualViewport
  const apply = (): void => {
    const height = vv ? vv.height : window.innerHeight
    document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`)
    // undo the scroll WebKit applies to bring the focused input into view
    if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0)
  }
  apply()
  vv?.addEventListener('resize', apply)
  vv?.addEventListener('scroll', apply)
  window.addEventListener('resize', apply)
}

function App(): React.JSX.Element {
  const loaded = useApp((s) => s.loaded)
  const screen = useApp((s) => s.screen)
  const notice = useApp((s) => s.notice)

  useEffect(() => {
    loadStore().catch((err) => {
      useApp.setState({ loaded: true })
      notify(`Could not read saved hosts: ${errText(err)}`)
    })
  }, [])

  if (!loaded) return <div className='screen' />

  return (
    <>
      {screen.name === 'hosts' && <HostsScreen />}
      {screen.name === 'hostForm' && <HostFormScreen hostId={screen.hostId} />}
      {screen.name === 'host' && <HostScreen />}
      {screen.name === 'session' && (
        <SessionScreen
          key={screen.sessionId}
          projectId={screen.projectId}
          sessionId={screen.sessionId}
        />
      )}
      <ConfirmHost />
      {notice && <div className='toast'>{notice}</div>}
    </>
  )
}

trackViewport()
createRoot(document.getElementById('root') as HTMLElement).render(<App />)
