import { useEffect, useRef, useState } from 'react'
import type { IDockviewPanelProps } from 'dockview'
import type { SessionPanelParams } from '@/components/dock/panels'
import { useFilesStore } from '@/stores/files'
import MonacoFileView, { disposeFileModel } from '@/components/files/MonacoFileView'

const EMPTY: string[] = []

function basename(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() ?? p
}

const FileViewerPanel: React.FC<IDockviewPanelProps<SessionPanelParams>> = (props) => {
  const { sessionId, hostId } = props.params
  const open = useFilesStore((s) => s.openBySession[sessionId] ?? EMPTY)
  const active = useFilesStore((s) => s.activeBySession[sessionId] ?? null)
  const setActive = useFilesStore((s) => s.setActive)
  const closeFile = useFilesStore((s) => s.closeFile)
  const [dirtyByPath, setDirtyByPath] = useState<Record<string, boolean>>({})
  const prevOpenRef = useRef<string[]>(open)

  // dispose monaco models (and dirty flags) for files that were closed
  useEffect(() => {
    const prev = prevOpenRef.current
    prevOpenRef.current = open
    for (const p of prev) {
      if (!open.includes(p)) {
        void disposeFileModel(hostId, p)
        setDirtyByPath((d) => {
          if (!(p in d)) return d
          const next = { ...d }
          delete next[p]
          return next
        })
      }
    }
  }, [open, hostId])

  const onDirtyChange = (path: string, dirty: boolean): void => {
    setDirtyByPath((d) => (d[path] === dirty ? d : { ...d, [path]: dirty }))
  }

  const close = (path: string): void => {
    if (dirtyByPath[path] && !window.confirm(`Discard unsaved changes in ${basename(path)}?`)) {
      return
    }
    closeFile(sessionId, path)
  }

  if (open.length === 0) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--ra-text-dim)',
          fontSize: 12.5,
          padding: 16,
          textAlign: 'center'
        }}
      >
        Click a file in the tree to open it here.
      </div>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          overflowX: 'auto',
          background: 'var(--ra-bg-raised)',
          borderBottom: '1px solid var(--ra-border)'
        }}
      >
        {open.map((p) => {
          const isActive = p === active
          return (
            <div
              key={p}
              title={p}
              onClick={() => setActive(sessionId, p)}
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  close(p)
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 8px 4px 10px',
                cursor: 'pointer',
                fontSize: 12,
                flexShrink: 0,
                maxWidth: 200,
                borderRight: '1px solid var(--ra-border)',
                background: isActive ? 'var(--ra-bg-panel)' : 'transparent',
                color: isActive ? 'var(--ra-text)' : 'var(--ra-text-dim)',
                boxShadow: isActive ? 'inset 0 2px 0 var(--ra-accent)' : 'none',
                userSelect: 'none'
              }}
            >
              <span
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {basename(p)}
              </span>
              {dirtyByPath[p] && (
                <span style={{ color: 'var(--ra-accent)', fontSize: 9, flexShrink: 0 }}>●</span>
              )}
              <span
                title='Close'
                onClick={(e) => {
                  e.stopPropagation()
                  close(p)
                }}
                style={{
                  flexShrink: 0,
                  color: 'var(--ra-text-faint)',
                  fontSize: 13,
                  lineHeight: 1,
                  padding: '1px 3px',
                  borderRadius: 3
                }}
              >
                ×
              </span>
            </div>
          )
        })}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {active ? (
          <MonacoFileView
            key={`${hostId}:${active}`}
            hostId={hostId}
            path={active}
            sessionId={sessionId}
            onDirtyChange={onDirtyChange}
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
            Select a tab.
          </div>
        )}
      </div>
    </div>
  )
}

export default FileViewerPanel
