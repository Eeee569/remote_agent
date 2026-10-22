import { useEffect } from 'react'
import type { ProjectMeta } from '@shared/domain'
import { initConnectionEvents, useConnectionStore } from '@/stores/connection'
import { useProjectsStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'
import HostPicker from '@/components/hosts/HostPicker'
import ConnectionBanner from '@/components/hosts/ConnectionBanner'
import HostFormDialog from '@/components/hosts/HostFormDialog'
import HostManagerDialog from '@/components/hosts/HostManagerDialog'
import ProjectTabBar from '@/components/projects/ProjectTabBar'
import AddProjectDialog from '@/components/projects/AddProjectDialog'
import NewSessionDialog from '@/components/projects/NewSessionDialog'
import DockWorkspace from '@/components/dock/DockWorkspace'
import GlobalGrid from '@/components/dock/GlobalGrid'
import Toasts from '@/components/common/Toasts'

const SETTINGS_ID = '__settings__'

const SETTINGS_PROJECT: ProjectMeta = {
  id: SETTINGS_ID,
  name: 'Settings',
  repoPath: '',
  createdAt: 0
}

const GLOBAL_KEYFRAMES = `
@keyframes ra-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}
`

const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

function CenterCard(props: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div
        style={{
          background: 'var(--ra-bg-raised)',
          border: '1px solid var(--ra-border)',
          borderRadius: 10,
          padding: '32px 40px',
          textAlign: 'center',
          maxWidth: 420
        }}
      >
        {props.children}
      </div>
    </div>
  )
}

export default function App(): React.JSX.Element {
  const hosts = useConnectionStore((s) => s.hosts)
  const activeHostId = useConnectionStore((s) => s.activeHostId)
  const status = useConnectionStore((s) =>
    s.activeHostId ? (s.statusByHost[s.activeHostId]?.status ?? 'idle') : 'idle'
  )
  const statusError = useConnectionStore((s) =>
    s.activeHostId ? s.statusByHost[s.activeHostId]?.error : undefined
  )
  const connect = useConnectionStore((s) => s.connect)
  const projects = useProjectsStore((s) => s.projects)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const hostFormOpen = useUiStore((s) => s.hostFormOpen)
  const hostManagerOpen = useUiStore((s) => s.hostManagerOpen)
  const addProjectOpen = useUiStore((s) => s.addProjectOpen)
  const newSessionOpen = useUiStore((s) => s.newSessionOpen)
  const openHostForm = useUiStore((s) => s.openHostForm)
  const openAddProject = useUiStore((s) => s.openAddProject)
  const openNewSession = useUiStore((s) => s.openNewSession)
  const globalGridOpen = useUiStore((s) => s.globalGridOpen)
  const toggleGlobalGrid = useUiStore((s) => s.toggleGlobalGrid)

  // a file dropped where nothing takes it (title bar, settings, …) would make
  // Chromium open it in place of the app; refuse it there instead
  useEffect(() => {
    const refuse = (e: DragEvent): void => {
      if (e.defaultPrevented || !e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'none'
    }
    window.addEventListener('dragover', refuse)
    window.addEventListener('drop', refuse)
    return () => {
      window.removeEventListener('dragover', refuse)
      window.removeEventListener('drop', refuse)
    }
  }, [])

  useEffect(() => {
    initConnectionEvents()
    void (async () => {
      await useConnectionStore.getState().refreshHosts()
      const s = useConnectionStore.getState()
      if (!s.activeHostId && s.hosts.length > 0) s.setActiveHost(s.hosts[0].id)
    })()
  }, [])

  const isMac = navigator.platform.startsWith('Mac')
  const connected = status === 'connected'
  const activeHost = hosts.find((h) => h.id === activeHostId) ?? null
  const activeProject =
    activeProjectId && activeProjectId !== SETTINGS_ID
      ? (projects.find((p) => p.id === activeProjectId) ?? null)
      : null
  const canNewSession = connected && activeProject !== null

  let main: React.JSX.Element
  if (hosts.length === 0) {
    main = (
      <CenterCard>
        <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>Welcome to Remote Agent</h2>
        <p style={{ color: 'var(--ra-text-dim)', margin: '0 0 20px' }}>
          Add an SSH host to run AI coding agents in tmux sessions on your server.
        </p>
        <button
          className='ra-btn primary'
          style={{ fontSize: 14, padding: '8px 22px' }}
          onClick={() => openHostForm(null)}
        >
          Add host
        </button>
      </CenterCard>
    )
  } else if (!activeHost) {
    main = (
      <CenterCard>
        <p style={{ color: 'var(--ra-text-dim)', margin: 0 }}>Select a host to get started.</p>
      </CenterCard>
    )
  } else if (!connected) {
    main = (
      <CenterCard>
        <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>{activeHost.label}</h2>
        <p style={{ color: 'var(--ra-text-dim)', margin: '0 0 6px', fontFamily: 'var(--ra-mono)', fontSize: 12 }}>
          {activeHost.username}@{activeHost.host}:{activeHost.port}
        </p>
        <p style={{ color: 'var(--ra-text-dim)', margin: '0 0 20px' }}>
          Status: {status}
          {statusError ? ` — ${statusError}` : ''}
        </p>
        <button
          className='ra-btn primary'
          style={{ fontSize: 14, padding: '8px 22px' }}
          disabled={status === 'connecting'}
          onClick={() => void connect(activeHost.id)}
        >
          {status === 'connecting' ? 'Connecting…' : 'Connect'}
        </button>
      </CenterCard>
    )
  } else if (globalGridOpen) {
    main = <GlobalGrid hostId={activeHost.id} />
  } else if (activeProjectId === SETTINGS_ID) {
    main = <DockWorkspace hostId={activeHost.id} project={SETTINGS_PROJECT} />
  } else if (!activeProject) {
    main = (
      <CenterCard>
        <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>Create or pick a project</h2>
        <p style={{ color: 'var(--ra-text-dim)', margin: '0 0 20px' }}>
          A project is a directory on the server. Any directory will do — one that is not a git
          repository is initialized as you add it. Sessions, worktrees, and layout live under it.
        </p>
        <button
          className='ra-btn primary'
          style={{ fontSize: 14, padding: '8px 22px' }}
          onClick={openAddProject}
        >
          Add project
        </button>
      </CenterCard>
    )
  } else {
    main = <DockWorkspace key={activeProject.id} hostId={activeHost.id} project={activeProject} />
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <style>{GLOBAL_KEYFRAMES}</style>

      <div
        style={
          {
            height: 'var(--ra-titlebar-h)',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: `0 12px 0 ${isMac ? 78 : 12}px`,
            background: 'var(--ra-bg-raised)',
            borderBottom: '1px solid var(--ra-border)',
            WebkitAppRegion: 'drag'
          } as React.CSSProperties
        }
      >
        <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: '-0.01em' }}>Remote Agent</span>
        <div style={noDrag}>
          <HostPicker />
        </div>
        <div style={{ flex: 1 }} />
        <button
          className='ra-btn'
          style={{
            ...noDrag,
            padding: '3px 12px',
            fontSize: 12,
            ...(globalGridOpen
              ? { background: 'var(--ra-bg-active)', color: 'var(--ra-text)', borderColor: 'var(--ra-accent)' }
              : {})
          }}
          disabled={!connected}
          title='Show every running session across all projects in one resizable grid'
          onClick={toggleGlobalGrid}
        >
          {globalGridOpen ? 'Exit Project Grid' : 'Project Grid'}
        </button>
        <button
          className='ra-btn primary'
          style={{ ...noDrag, padding: '3px 12px', fontSize: 12 }}
          disabled={!canNewSession}
          onClick={openNewSession}
        >
          New session
        </button>
      </div>

      <ConnectionBanner />
      {connected && <ProjectTabBar />}

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>{main}</div>

      {hostManagerOpen && <HostManagerDialog />}
      {hostFormOpen && <HostFormDialog />}
      {addProjectOpen && <AddProjectDialog />}
      {newSessionOpen && canNewSession && <NewSessionDialog />}
      <Toasts />
    </div>
  )
}
