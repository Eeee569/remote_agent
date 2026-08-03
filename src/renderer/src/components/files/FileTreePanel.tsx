import type { IDockviewPanelProps } from 'dockview'
import type { SessionPanelParams } from '@/components/dock/panels'
import { useProjectsStore } from '@/stores/projects'
import FileTree from '@/components/files/FileTree'

const FileTreePanel: React.FC<IDockviewPanelProps<SessionPanelParams>> = (props) => {
  const { sessionId, hostId, projectId } = props.params
  const session = useProjectsStore((s) =>
    (s.sessionsByProject[projectId] ?? []).find((x) => x.id === sessionId)
  )

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

  return <FileTree hostId={hostId} rootPath={session.cwd} sessionId={sessionId} />
}

export default FileTreePanel
