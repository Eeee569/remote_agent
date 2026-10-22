import { useCallback, useEffect, useRef, useState } from 'react'
import { DockviewReact } from 'dockview'
import type { DockviewApi, DockviewReadyEvent } from 'dockview'
import type { ProjectLayout, ProjectMeta, SessionLayoutMode, SessionMeta } from '@shared/domain'
import { api } from '@/api'
import { panelComponents } from '@/components/dock/panels'
import type { PlaceholderPanelParams, SessionPanelParams } from '@/components/dock/panels'
import SessionBar from '@/components/dock/SessionBar'
import {
  PLACEHOLDER_PREFIX,
  SESSION_PANEL_KINDS,
  addSessionPanels,
  applySessionLayout,
  closeSessionPanels,
  collapseSessionPanels,
  expandSessionPanels,
  panelId,
  parseSessionPanelId,
  resolveFocused,
  sessionPanelIds,
  sessionsForMode
} from '@/components/dock/session-layout'
import type { SessionPanelContext, SessionPanelKind } from '@/components/dock/session-layout'
import { useFilesStore } from '@/stores/files'
import { killedByUser, useProjectsStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'

const SETTINGS_ID = '__settings__'
const PERSIST_DEBOUNCE_MS = 2000

interface DockWorkspaceProps {
  hostId: string
  project: ProjectMeta
}

/** Layout snapshot taken while the workspace is still mounted and intact. */
interface PendingLayout {
  dockview: unknown
  openFilesBySession: Record<string, string[]>
  closedPanels: string[]
  sessionLayoutMode: SessionLayoutMode
  focusedSessionId: string | null
}

/**
 * The dockview workspace for one project (or the special "__settings__"
 * pseudo-project). Restores the layout persisted on the server, keeps panels
 * in sync with the sessions store, and writes layout changes back (debounced).
 *
 * Panels are owned by their session: closing a session's terminal closes its
 * shell, files, and viewer with it, and killing a session takes all of them
 * away. Closed panels are remembered so reconciliation does not resurrect
 * them; the session bar puts them back. The layout mode decides which
 * sessions are on screen at all — one in "focus", every session when tiled.
 */
export default function DockWorkspace({ hostId, project }: DockWorkspaceProps): React.JSX.Element {
  const apiRef = useRef<DockviewApi | null>(null)
  const readyRef = useRef(false)
  const [ready, setReady] = useState(false)
  const readyDisposeRef = useRef<(() => void) | null>(null)
  const pendingLayoutRef = useRef<PendingLayout | null>(null)
  const persistTimerRef = useRef<number | null>(null)
  const sessions = useProjectsStore((s) => s.sessionsByProject[project.id])
  const addToast = useUiStore((s) => s.addToast)

  // state the workspace drives panels from; refs mirror it so the dockview
  // callbacks (which run outside React's render cycle) see it synchronously
  const [mode, setMode] = useState<SessionLayoutMode>('focus')
  const modeRef = useRef(mode)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const focusedRef = useRef(focusedId)
  /** panel ids the user closed; a closed "term:<id>" hides the whole session */
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())
  const closedRef = useRef<ReadonlySet<string>>(closed)
  /** sessions whose panels we are removing ourselves */
  const suppressRef = useRef(new Set<string>())
  /** which sessions were on screen last sync, to spot new/gone ones */
  const shownRef = useRef('')

  const setModeSynced = useCallback((next: SessionLayoutMode): void => {
    modeRef.current = next
    setMode(next)
  }, [])

  const setFocusedSynced = useCallback((next: string | null): void => {
    focusedRef.current = next
    setFocusedId(next)
  }, [])

  const setClosedSynced = useCallback((next: ReadonlySet<string>): void => {
    closedRef.current = next
    setClosed(next)
  }, [])

  const markClosed = useCallback(
    (ids: string[]): void => {
      if (ids.length === 0) return
      const next = new Set(closedRef.current)
      for (const id of ids) next.add(id)
      setClosedSynced(next)
    },
    [setClosedSynced]
  )

  const markOpen = useCallback(
    (ids: string[]): void => {
      const next = new Set(closedRef.current)
      let changed = false
      for (const id of ids) changed = next.delete(id) || changed
      if (changed) setClosedSynced(next)
    },
    [setClosedSynced]
  )

  const ctx = useCallback(
    (): SessionPanelContext => ({ hostId, projectId: project.id, mode: modeRef.current }),
    [hostId, project.id]
  )

  const sessionById = useCallback(
    (sessionId: string): SessionMeta | undefined =>
      (useProjectsStore.getState().sessionsByProject[project.id] ?? []).find(
        (s) => s.id === sessionId
      ),
    [project.id]
  )

  // ---------------- persistence ----------------

  const capturePending = useCallback((): void => {
    const dv = apiRef.current
    if (!dv || !readyRef.current || project.id === SETTINGS_ID) return
    const list = useProjectsStore.getState().sessionsByProject[project.id]
    if (!list) return
    const sessionIds = new Set(list.map((s) => s.id))
    const openFilesBySession: Record<string, string[]> = {}
    for (const [sid, paths] of Object.entries(useFilesStore.getState().openBySession)) {
      if (sessionIds.has(sid)) openFilesBySession[sid] = paths
    }
    try {
      pendingLayoutRef.current = {
        dockview: dv.toJSON(),
        openFilesBySession,
        closedPanels: [...closedRef.current],
        sessionLayoutMode: modeRef.current,
        focusedSessionId: focusedRef.current
      }
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
    const pending = pendingLayoutRef.current
    if (pending === null) return
    // a missing session list means the projects store was reset (host switch),
    // not a project without sessions — writing now would erase good state
    if (!useProjectsStore.getState().sessionsByProject[project.id]) return
    pendingLayoutRef.current = null
    const layout: ProjectLayout = {
      dockview: pending.dockview,
      openFilesBySession: pending.openFilesBySession,
      closedPanels: pending.closedPanels,
      sessionLayoutMode: pending.sessionLayoutMode,
      focusedSessionId: pending.focusedSessionId,
      schemaVersion: 1
    }
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

  // ---------------- panel construction ----------------

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

  /** The empty-project placeholders make way for the first real session. */
  const removeSettingsPanels = useCallback((dv: DockviewApi): void => {
    for (const id of ['settings', 'install']) {
      const panel = dv.getPanel(id)
      if (panel) {
        try {
          dv.removePanel(panel)
        } catch {
          // already disposed
        }
      }
    }
  }, [])

  const rebindPanels = useCallback(
    (dv: DockviewApi): void => {
      // the layout lives on the server and is shared across clients, so restored
      // params can carry a host record id that is local to another machine
      for (const panel of dv.panels) {
        const params = panel.params as Partial<SessionPanelParams> | undefined
        if (typeof params?.hostId !== 'string') continue
        try {
          panel.api.updateParameters({ hostId, projectId: project.id })
        } catch {
          // panel disposed mid-restore
        }
      }
    },
    [hostId, project.id]
  )

  /** Runs `fn` without the terminal-close reaction firing for `sessionId`. */
  const suppressing = useCallback((sessionId: string, fn: () => void): void => {
    suppressRef.current.add(sessionId)
    try {
      fn()
    } finally {
      // panel removal events are delivered synchronously, but the reaction
      // re-checks on the next tick — keep the guard until it has run
      window.setTimeout(() => suppressRef.current.delete(sessionId), 0)
    }
  }, [])

  // ---------------- the one place panels are brought in line ----------------

  /**
   * Make the dock show exactly what the current mode, focus, and closed-panel
   * set call for. `arrange` re-runs the layout of the shown sessions; without
   * it, existing panels are left wherever the user dragged them.
   */
  const syncPanels = useCallback(
    (opts: { arrange?: boolean } = {}): void => {
      const dv = apiRef.current
      if (!dv || !readyRef.current || project.id === SETTINGS_ID) return
      const list = useProjectsStore.getState().sessionsByProject[project.id] ?? []
      const known = new Set(list.map((s) => s.id))
      const closedNow = closedRef.current

      const nextFocused = resolveFocused(list, focusedRef.current, closedNow)
      if (nextFocused !== focusedRef.current) setFocusedSynced(nextFocused)

      const show = sessionsForMode(list, modeRef.current, nextFocused, closedNow)
      const showIds = new Set(show.map((s) => s.id))

      // sessions this mode does not show lose their panels (they are not
      // "closed" — switching back brings them straight home)
      const toHide = new Set<string>()
      for (const panel of dv.panels) {
        const parsed = parseSessionPanelId(panel.id)
        if (parsed && known.has(parsed.sessionId) && !showIds.has(parsed.sessionId)) {
          toHide.add(parsed.sessionId)
        }
      }
      for (const sessionId of toHide) {
        suppressing(sessionId, () => closeSessionPanels(dv, sessionId))
      }

      for (const s of show) {
        const missing = SESSION_PANEL_KINDS.filter(
          (kind) => !closedNow.has(panelId(kind, s.id)) && !dv.getPanel(panelId(kind, s.id))
        )
        if (missing.length === 0) continue
        if (dv.getPanel('settings')) removeSettingsPanels(dv)
        addSessionPanels(dv, s, ctx(), missing)
      }

      // Only the grid has to reflow when the set on screen changes; columns
      // and rows append correctly on their own, and re-tiling would throw
      // away splits and drags the user made inside their tiles.
      const key = show.map((s) => s.id).join(',')
      const changed = key !== shownRef.current
      shownRef.current = key
      const arrange = opts.arrange ?? (changed && modeRef.current === 'grid' && show.length > 1)
      if (show.length > 0 && arrange) applySessionLayout(dv, show, ctx())
      if (show.length === 0 && dv.panels.length === 0) addSettingsPanels(dv)
    },
    [
      addSettingsPanels,
      ctx,
      project.id,
      removeSettingsPanels,
      setFocusedSynced,
      suppressing
    ]
  )

  // ---------------- session bar actions ----------------

  /** Focus mode: switch to this session. Tiled: bring its terminal forward. */
  const selectSession = useCallback(
    (sessionId: string): void => {
      const dv = apiRef.current
      if (!dv) return
      const wasHidden = closedRef.current.has(panelId('term', sessionId))
      if (wasHidden) markOpen(sessionPanelIds(sessionId))
      if (modeRef.current === 'focus') {
        setFocusedSynced(sessionId)
        syncPanels({ arrange: true })
      } else {
        syncPanels()
        try {
          dv.getPanel(panelId('term', sessionId))?.api.setActive()
        } catch {
          // panel disposed
        }
      }
      schedulePersist()
    },
    [markOpen, schedulePersist, setFocusedSynced, syncPanels]
  )

  /** Close every panel of a session; the tmux session keeps running. */
  const closeSession = useCallback(
    (sessionId: string): void => {
      const dv = apiRef.current
      if (!dv) return
      suppressing(sessionId, () => closeSessionPanels(dv, sessionId))
      markClosed(sessionPanelIds(sessionId))
      syncPanels({ arrange: modeRef.current !== 'focus' })
      schedulePersist()
    },
    [markClosed, schedulePersist, suppressing, syncPanels]
  )

  /** Reopen a single panel a session lost, or close one it still has. */
  const togglePanel = useCallback(
    (sessionId: string, kind: SessionPanelKind): void => {
      const dv = apiRef.current
      if (!dv) return
      const id = panelId(kind, sessionId)
      if (closedRef.current.has(id)) {
        markOpen([id])
        if (kind === 'term' && modeRef.current === 'focus') setFocusedSynced(sessionId)
        syncPanels()
      } else if (kind === 'term') {
        closeSession(sessionId)
        return
      } else {
        const panel = dv.getPanel(id)
        if (panel) suppressing(sessionId, () => dv.removePanel(panel))
        markClosed([id])
      }
      schedulePersist()
    },
    [closeSession, markClosed, markOpen, schedulePersist, setFocusedSynced, suppressing, syncPanels]
  )

  /** Stop the tmux session itself (same confirmations as the panel header). */
  const killSessionById = useCallback(
    (sessionId: string): void => {
      const session = sessionById(sessionId)
      if (!session) return
      if (!window.confirm(`Kill tmux session "${session.tmuxName}"? The agent inside will stop.`)) {
        return
      }
      const alsoRemoveWorktree =
        session.mode === 'worktree'
          ? window.confirm(`Also remove the git worktree at ${session.worktree?.path ?? session.cwd}?`)
          : false
      void useProjectsStore
        .getState()
        .killSession(hostId, project.id, sessionId, alsoRemoveWorktree)
    },
    [hostId, project.id, sessionById]
  )

  /** Split one session's panels apart inside its tile, or tab them back. */
  const arrangeSession = useCallback(
    (sessionId: string, layout: 'split' | 'tabs'): void => {
      const dv = apiRef.current
      const session = sessionById(sessionId)
      if (!dv || !session) return
      if (layout === 'split') expandSessionPanels(dv, session)
      else collapseSessionPanels(dv, session)
      schedulePersist()
    },
    [schedulePersist, sessionById]
  )

  const changeMode = useCallback(
    (next: SessionLayoutMode): void => {
      if (next === modeRef.current) return
      setModeSynced(next)
      syncPanels({ arrange: true })
      schedulePersist()
    },
    [schedulePersist, setModeSynced, syncPanels]
  )

  // ---------------- dockview lifecycle ----------------

  const onReady = useCallback(
    (event: DockviewReadyEvent): void => {
      apiRef.current = event.api
      readyRef.current = false
      let disposed = false
      const layoutSub = event.api.onDidLayoutChange(() => schedulePersist())

      // a session's panels live and die together: closing the terminal closes
      // the rest. dockview also reports a removal when a panel is dragged to
      // another group, so confirm on the next tick that it is really gone.
      const removeSub = event.api.onDidRemovePanel((panel) => {
        if (!readyRef.current || project.id === SETTINGS_ID) return
        const parsed = parseSessionPanelId(panel.id)
        if (!parsed) return
        const { kind, sessionId } = parsed
        window.setTimeout(() => {
          const dv = apiRef.current
          if (!dv || !readyRef.current || disposed) return
          if (dv.getPanel(panel.id)) return // moved between groups, not closed
          if (suppressRef.current.has(sessionId)) return
          if (kind === 'term') {
            suppressing(sessionId, () => closeSessionPanels(dv, sessionId))
            markClosed(sessionPanelIds(sessionId))
            syncPanels({ arrange: modeRef.current !== 'focus' })
            addToast(
              'info',
              'Session panels closed — tmux keeps running. Reopen it from the session bar.'
            )
          } else {
            markClosed([panel.id])
          }
          schedulePersist()
        }, 0)
      })

      readyDisposeRef.current = () => {
        disposed = true
        layoutSub.dispose()
        removeSub.dispose()
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

        setModeSynced(layout?.sessionLayoutMode ?? 'focus')
        setFocusedSynced(layout?.focusedSessionId ?? null)
        setClosedSynced(new Set(layout?.closedPanels ?? []))

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
        if (restored) rebindPanels(event.api)
        useFilesStore.getState().hydrate(layout?.openFilesBySession ?? {})
        readyRef.current = true
        // restored layouts keep their arrangement; a fresh one is built here
        syncPanels({ arrange: !restored })
        setReady(true)
      }
      void init()
    },
    [
      addSettingsPanels,
      addToast,
      hostId,
      markClosed,
      project.id,
      rebindPanels,
      schedulePersist,
      setClosedSynced,
      setFocusedSynced,
      setModeSynced,
      suppressing,
      syncPanels
    ]
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

  // closing/reopening panels and switching mode are layout changes in their
  // own right — dockview's own event cannot see them
  useEffect(() => {
    if (!ready || project.id === SETTINGS_ID) return
    schedulePersist()
  }, [closed, mode, focusedId, ready, project.id, schedulePersist])

  // persist when the set of open files changes, and bring the viewer back if
  // a file is opened while it is closed
  useEffect(() => {
    if (project.id === SETTINGS_ID) return undefined
    return useFilesStore.subscribe((state, prev) => {
      if (state.openBySession === prev.openBySession) return
      const dv = apiRef.current
      if (dv && readyRef.current) {
        for (const [sessionId, paths] of Object.entries(state.openBySession)) {
          if (paths.length === 0 || paths.length <= (prev.openBySession[sessionId]?.length ?? 0)) {
            continue
          }
          if (dv.getPanel(panelId('view', sessionId))) continue
          const session = (useProjectsStore.getState().sessionsByProject[project.id] ?? []).find(
            (s) => s.id === sessionId
          )
          if (!session) continue
          markOpen([panelId('view', sessionId)])
          addSessionPanels(dv, session, ctx(), ['view'])
        }
      }
      schedulePersist()
    })
  }, [ctx, markOpen, project.id, schedulePersist])

  // ---------------- session <-> panel reconciliation ----------------

  useEffect(() => {
    const dv = apiRef.current
    if (!dv || !ready || project.id === SETTINGS_ID) return
    const list = sessions ?? []
    const known = new Set(list.map((s) => s.id))

    // panels whose session no longer exists
    const stale = new Set<string>()
    for (const panel of dv.panels) {
      const parsed = parseSessionPanelId(panel.id)
      if (parsed && !known.has(parsed.sessionId)) stale.add(parsed.sessionId)
    }
    for (const sessionId of stale) {
      const killedHere = killedByUser.delete(sessionId)
      if (killedHere) {
        // the user asked for it — take every window with it, no tombstone
        suppressing(sessionId, () => closeSessionPanels(dv, sessionId))
        useFilesStore.getState().forgetSession(sessionId)
        continue
      }
      const term = dv.getPanel(panelId('term', sessionId))
      const reference = term ?? dv.panels.find((p) => p.id.endsWith(`:${sessionId}`))
      const title = term?.title ?? reference?.title ?? sessionId
      if (reference && !dv.getPanel(PLACEHOLDER_PREFIX + sessionId)) {
        try {
          const params: PlaceholderPanelParams = { sessionId, title }
          dv.addPanel<PlaceholderPanelParams>({
            id: PLACEHOLDER_PREFIX + sessionId,
            component: 'placeholder',
            title,
            params,
            position: { referencePanel: reference.id, direction: 'within' }
          })
        } catch {
          // placeholder is cosmetic; still remove the dead panels
        }
      }
      suppressing(sessionId, () => closeSessionPanels(dv, sessionId, { keepPlaceholder: true }))
    }

    // forget closed-panel ids of sessions that are gone — including hidden
    // sessions, which own no panels for the sweep above to notice
    const orphaned = [...closedRef.current].filter((id) => {
      const sessionId = parseSessionPanelId(id)?.sessionId
      return sessionId === undefined || !known.has(sessionId)
    })
    if (orphaned.length > 0) {
      for (const id of orphaned) {
        const sessionId = parseSessionPanelId(id)?.sessionId
        if (sessionId === undefined) continue
        killedByUser.delete(sessionId)
        useFilesStore.getState().forgetSession(sessionId)
      }
      markOpen(orphaned)
    }

    syncPanels()
  }, [sessions, ready, project.id, markOpen, suppressing, syncPanels])

  const sessionList: SessionMeta[] = sessions ?? []

  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column' }}>
      {project.id !== SETTINGS_ID && (
        <SessionBar
          sessions={sessionList}
          closed={closed}
          mode={mode}
          focusedSessionId={focusedId}
          onSelect={selectSession}
          onTogglePanel={togglePanel}
          onCloseSession={closeSession}
          onKillSession={killSessionById}
          onArrangeSession={arrangeSession}
          onModeChange={changeMode}
        />
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <DockviewReact
          className={`dockview-theme-dark dockview-theme-ra${mode === 'focus' ? '' : ' ra-tiled'}`}
          components={panelComponents}
          onReady={onReady}
        />
      </div>
    </div>
  )
}
