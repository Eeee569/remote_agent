import { useConnectionStore } from '@/stores/connection'
import { useProjectsStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'

const SETTINGS_ID = '__settings__'

export default function ProjectTabBar(): React.JSX.Element | null {
  const activeHostId = useConnectionStore((s) => s.activeHostId)
  const projects = useProjectsStore((s) => s.projects)
  const activeProjectId = useProjectsStore((s) => s.activeProjectId)
  const setActiveProject = useProjectsStore((s) => s.setActiveProject)
  const loadSessions = useProjectsStore((s) => s.loadSessions)
  const removeProject = useProjectsStore((s) => s.removeProject)
  const openAddProject = useUiStore((s) => s.openAddProject)

  if (!activeHostId) return null

  const tabBase: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 12px',
    height: '100%',
    cursor: 'pointer',
    borderRight: '1px solid var(--ra-border)',
    fontSize: 12.5,
    userSelect: 'none',
    whiteSpace: 'nowrap'
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'stretch',
        height: 32,
        flexShrink: 0,
        background: 'var(--ra-bg-raised)',
        borderBottom: '1px solid var(--ra-border)',
        overflow: 'hidden'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'stretch', overflowX: 'auto', flex: 1 }}>
        {projects.map((p) => {
          const active = p.id === activeProjectId
          return (
            <div
              key={p.id}
              onClick={() => {
                setActiveProject(p.id)
                void loadSessions(activeHostId, p.id)
              }}
              style={{
                ...tabBase,
                background: active ? 'var(--ra-bg-panel)' : 'transparent',
                color: active ? 'var(--ra-text)' : 'var(--ra-text-dim)',
                boxShadow: active ? 'inset 0 2px 0 var(--ra-accent-strong)' : 'none'
              }}
            >
              <span style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {p.name}
              </span>
              <span
                aria-label={`Close ${p.name}`}
                onClick={(e) => {
                  e.stopPropagation()
                  if (
                    window.confirm(
                      `Remove project "${p.name}" from Remote Agent?\nNothing is deleted on the server.`
                    )
                  ) {
                    void removeProject(activeHostId, p.id)
                  }
                }}
                style={{
                  color: 'var(--ra-text-faint)',
                  fontSize: 13,
                  lineHeight: 1,
                  padding: '2px 3px',
                  borderRadius: 3
                }}
              >
                ×
              </span>
            </div>
          )
        })}
        <div
          onClick={openAddProject}
          title='Add project'
          style={{ ...tabBase, color: 'var(--ra-text-dim)', fontSize: 15 }}
        >
          +
        </div>
      </div>
      <div
        onClick={() => setActiveProject(SETTINGS_ID)}
        title='Settings'
        style={{
          ...tabBase,
          borderRight: 'none',
          borderLeft: '1px solid var(--ra-border)',
          background: activeProjectId === SETTINGS_ID ? 'var(--ra-bg-panel)' : 'transparent',
          color: activeProjectId === SETTINGS_ID ? 'var(--ra-text)' : 'var(--ra-text-dim)',
          boxShadow:
            activeProjectId === SETTINGS_ID ? 'inset 0 2px 0 var(--ra-accent-strong)' : 'none'
        }}
      >
        ⚙ Settings
      </div>
    </div>
  )
}
