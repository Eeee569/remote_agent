import { useCallback, useEffect, useRef, useState } from 'react'
import { DockviewReact } from 'dockview'
import type { DockviewApi, DockviewReadyEvent } from 'dockview'
import type { ProjectLayout, ProjectMeta, SessionMeta } from '@shared/domain'
import { api } from '@/api'
import { panelComponents } from '@/components/dock/panels'
import type { PlaceholderPanelParams, SessionPanelParams } from '@/components/dock/panels'
import { useFilesStore } from '@/stores/files'
import { useProjectsStore } from '@/stores/projects'

const SETTINGS_ID = '__settings__'
const PERSIST_DEBOUNCE_MS = 2000
const SESSION_PANEL_RE = /^(?:term|tree|view):(.+)$/

interface DockWorkspaceProps {
  hostId: string
  project: ProjectMeta
}

/**
 * The dockview workspace for one project (or the special "__settings__"
 * pseudo-project). Restores the layout persisted on the server, keeps panels
 * in sync with the sessions store, and writes layout changes back (debounced).
 */
export default function DockWorkspace({ hostId, project }: DockWorkspaceProps): React.JSX.Element {
  const apiRef = useRef<DockviewApi | null>(null)
  const readyRef = useRef(false)
  const [ready, setReady] = useState(false)
  const readyDisposeRef = useRef<(() => void) | null>(null)
  const pendingLayoutRef = useRef<unknown | null>(null)
  const persistTimerRef = useRef<number | null>(null)
  const sessions = useProjectsStore((s) => s.sessionsByProject[project.id])

  // ---------------- panel construction ----------------

  const addSessionPanels = useCallback(
    (dv: DockviewApi, s: SessionMeta): void => {
      const termId = `term:${s.id}`
      const treeId = `tree:${s.id}`
      const viewId = `view:${s.id}`
      if (dv.getPanel(termId)) return
      const params: SessionPanelParams = { sessionId: s.id, hostId, projectId: project.id }
      dv.addPanel<SessionPanelParams>({
        id: termId,
        component: 'terminal',
        title: s.tmuxName,
        params
      })
      if (!dv.getPanel(treeId)) {
        dv.addPanel<SessionPanelParams>({
          id: treeId,
          component: 'tree',
          title: `Files — ${s.tmuxName}`,
          params,
          position: { referencePanel: termId, direction: 'right' }
        })
      }
      if (!dv.getPanel(viewId)) {
        dv.addPanel<SessionPanelParams>({
          id: viewId,
          component: 'viewer',
          title: `Viewer — ${s.tmuxName}`,
          params,
          position: { referencePanel: treeId, direction: 'below' }
        })
      }
      try {
        // size the tree/viewer column to roughly 45% of the workspace width
        const width = Math.round(dv.width * 0.45)
        if (width > 0) dv.getPanel(treeId)?.api.setSize({ width })
      } catch {
        // best-effort: dockview sizing APIs vary
      }
      try {
        dv.getPanel(termId)?.api.setActive()
      } catch {
        // focusing is cosmetic
      }
    },
    [hostId, project.id]
  )

  const addSettingsPanels = useCallback(
    (dv: DockviewApi): void => {
      if (!dv.getPanel('settings')) {
        dv.addPanel({
          id: 'settings',
          component: 'settings',
          title: 'Settings',
          params: { hostId, projectId: project.id, repoPath: project.repoPath }
        })
      }
      if (!dv.getPanel('install')) {
        dv.addPanel({
          id: 'install',
          component: 'install',
          title: 'Install tools',
          params: { hostId },
          position: { referencePanel: 'settings', direction: 'within' }
        })
      }
      try {
        dv.getPanel('settings')?.api.setActive()
      } catch {
        // focusing is cosmetic
      }
    },
    [hostId, project.id, project.repoPath]
  )

  // ---------------- persistence ----------------

  const capturePending = useCallback((): void => {
    const dv = apiRef.current
    if (!dv || !readyRef.current || project.id === SETTINGS_ID) return
    try {
      pendingLayoutRef.current = dv.toJSON()
    } catch {
      // dockview mid-teardown; keep the previous snapshot
    }
  }, [project.id])

  const flushPersist = useCallback((): void => {
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current)
      persistTimerRef.current = null
    }
    if (project.id === SETTINGS_ID) return
    const dockviewJson = pendingLayoutRef.current
    if (dockviewJson === null) return
    pendingLayoutRef.current = null
    const sessionIds = new Set(
      (useProjectsStore.getState().sessionsByProject[project.id] ?? []).map((s) => s.id)
    )
    const openFilesBySession: Record<string, string[]> = {}
    for (const [sid, paths] of Object.entries(useFilesStore.getState().openBySession)) {
      if (sessionIds.has(sid)) openFilesBySession[sid] = paths
    }
    const layout: ProjectLayout = { dockview: dockviewJson, openFilesBySession, schemaVersion: 1 }
    void api.layoutWrite(hostId, project.id, layout).catch(() => {
      // persistence is best-effort; the next layout change retries
    })
  }, [hostId, project.id])

  const schedulePersist = useCallback((): void => {
    if (!readyRef.current || project.id === SETTINGS_ID) return
    capturePending()
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current)
    persistTimerRef.current = window.setTimeout(flushPersist, PERSIST_DEBOUNCE_MS)
  }, [capturePending, flushPersist, project.id])

  // ---------------- dockview lifecycle ----------------

  const onReady = useCallback(
    (event: DockviewReadyEvent): void => {
      apiRef.current = event.api
      readyRef.current = false
      let disposed = false
      const layoutSub = event.api.onDidLayoutChange(() => schedulePersist())
      readyDisposeRef.current = () => {
        disposed = true
        layoutSub.dispose()
      }

      const init = async (): Promise<void> => {
        if (project.id === SETTINGS_ID) {
          addSettingsPanels(event.api)
          readyRef.current = true
          setReady(true)
          return
        }
        await useProjectsStore.getState().loadSessions(hostId, project.id)
        let layout: ProjectLayout | null = null
        try {
          layout = await api.layoutRead(hostId, project.id)
        } catch {
          layout = null
        }
        if (disposed) return
        let restored = false
        if (layout?.dockview) {
          try {
            event.api.fromJSON(layout.dockview as never)
            restored = true
          } catch {
            try {
              event.api.clear()
            } catch {
              // already empty
            }
          }
        }
        useFilesStore.getState().hydrate(layout?.openFilesBySession ?? {})
        if (!restored) {
          const list = useProjectsStore.getState().sessionsByProject[project.id] ?? []
          if (list.length === 0) {
            // keep the workspace non-empty until the first session exists
            addSettingsPanels(event.api)
          } else {
            for (const s of list) addSessionPanels(event.api, s)
          }
        }
        readyRef.current = true
        setReady(true)
      }
      void init()
    },
    [hostId, project.id, addSessionPanels, addSettingsPanels, schedulePersist]
  )

  // flush pending writes + drop subscriptions on unmount
  useEffect(() => {
    return () => {
      readyDisposeRef.current?.()
      readyDisposeRef.current = null
      flushPersist()
      readyRef.current = false
      apiRef.current = null
    }
  }, [flushPersist])

  // persist when the set of open files changes (tab opens/closes)
  useEffect(() => {
    if (project.id === SETTINGS_ID) return undefined
    return useFilesStore.subscribe((state, prev) => {
      if (state.openBySession !== prev.openBySession) schedulePersist()
    })
  }, [project.id, schedulePersist])

  // ---------------- session <-> panel reconciliation ----------------

  useEffect(() => {
    const dv = apiRef.current
    if (!dv || !ready || project.id === SETTINGS_ID) return
    const list = sessions ?? []
    const known = new Set(list.map((s) => s.id))

    // sessions with no panels yet -> add the trio
    for (const s of list) {
      if (!dv.getPanel(`term:${s.id}`)) addSessionPanels(dv, s)
    }

    // panels whose session no longer exists -> replace with one placeholder
    const stale = new Set<string>()
    for (const panel of dv.panels) {
      const m = SESSION_PANEL_RE.exec(panel.id)
      if (m && !known.has(m[1])) stale.add(m[1])
    }
    for (const sessionId of stale) {
      const term = dv.getPanel(`term:${sessionId}`)
      const tree = dv.getPanel(`tree:${sessionId}`)
      const view = dv.getPanel(`view:${sessionId}`)
      const reference = term ?? tree ?? view
      const oldTitle = term?.title ?? reference?.title ?? sessionId
      if (reference && !dv.getPanel(`gone:${sessionId}`)) {
        try {
          const params: PlaceholderPanelParams = { sessionId, title: oldTitle }
          dv.addPanel<PlaceholderPanelParams>({
            id: `gone:${sessionId}`,
            component: 'placeholder',
            title: oldTitle,
            params,
            position: { referencePanel: reference.id, direction: 'within' }
          })
        } catch {
          // placeholder is cosmetic; still remove the dead panels
        }
      }
      for (const p of [term, tree, view]) {
        if (p) dv.removePanel(p)
      }
    }
  }, [sessions, ready, project.id, addSessionPanels])

  return (
    <div style={{ height: '100%', width: '100%' }}>
      <DockviewReact
        className='dockview-theme-dark dockview-theme-ra'
        components={panelComponents}
        onReady={onReady}
      />
    </div>
  )
}
