import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { DockviewReact } from 'dockview'
import type { DockviewApi, DockviewReadyEvent, IDockviewPanelProps } from 'dockview'
import type { AgentKind, SessionMeta } from '@shared/domain'
import {
  applySessionLayout,
  panelId,
  parseSessionPanelId,
  projectAccent
} from '@/components/dock/session-layout'
import {
  planGridReconcile,
  readGridLayout,
  writeGridLayout
} from '@/components/dock/project-grid-layout'
import type { GridMode, GridPanelRef, SavedGridLayout } from '@/components/dock/project-grid-layout'
import XtermView from '@/components/terminal/XtermView'
import { useProjectsStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'

const AGENT_COLOR: Record<AgentKind, string> = {
  claude: 'var(--ra-purple)',
  codex: 'var(--ra-green)',
  shell: 'var(--ra-text-dim)'
}

/** Only the tiling arrangements make sense across projects — no single focus. */
const SAVE_DEBOUNCE_MS = 300

const GRID_MODES: Array<{ value: GridMode; label: string; title: string }> = [
  { value: 'columns', label: 'Columns', title: 'Every session side by side, one column each' },
  { value: 'rows', label: 'Rows', title: 'Every session stacked, one row each' },
  { value: 'grid', label: 'Grid', title: 'Every session in its own cell of a grid' }
]

interface GlobalGridProps {
  hostId: string
}

interface GridPanelParams {
  sessionId: string
  hostId: string
  projectId: string
}

/**
 * Cross-project overview ("Project Grid"): every session on the host in one
 * dockview, so tiles can be dragged apart, resized, and re-split vertically or
 * horizontally just like a project workspace. It spins up a live terminal per
 * session when opened and tears them all down on exit, but the arrangement is
 * kept (per host, in localStorage) and restored as it was on the next open:
 * gone sessions lose their tile and new ones are appended, so nothing that
 * stays is moved. Each tile keeps its project's accent colour so you can
 * still tell which project a window belongs to after rearranging.
 *
 * The Columns / Rows / Grid buttons reuse the same arrange helpers the session
 * bar does; drag a panel to a group edge for arbitrary splits in between.
 */
export default function GlobalGrid({ hostId }: GlobalGridProps): React.JSX.Element {
  const projects = useProjectsStore((s) => s.projects)
  const sessionsByProject = useProjectsStore((s) => s.sessionsByProject)

  const apiRef = useRef<DockviewApi | null>(null)
  const [ready, setReady] = useState(false)
  const [mode, setMode] = useState<GridMode>(() => readGridLayout(hostId)?.mode ?? 'grid')
  const modeRef = useRef(mode)
  modeRef.current = mode
  /** null until every project's sessions have been asked for */
  const [unloaded, setUnloaded] = useState<ReadonlySet<string> | null>(null)
  /** set once the saved arrangement (or a fresh one) is on screen */
  const restoredRef = useRef(false)
  /** latest arrangement not yet written to storage */
  const pendingRef = useRef<SavedGridLayout | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const closingRef = useRef(false)

  // pull in the sessions of every project, not just the one that was active;
  // nothing is restored or pruned until this settles, or tiles of projects
  // still loading would be mistaken for deleted ones
  useEffect(() => {
    let cancelled = false
    void useProjectsStore
      .getState()
      .loadAllSessions(hostId)
      .then((failed) => {
        if (!cancelled) setUnloaded(failed)
      })
    return () => {
      cancelled = true
    }
  }, [hostId])

  // sessions grouped by project order, so like-project tiles start adjacent
  const sessions = useMemo<SessionMeta[]>(() => {
    const out: SessionMeta[] = []
    for (const p of projects) out.push(...(sessionsByProject[p.id] ?? []))
    return out
  }, [projects, sessionsByProject])

  const flushSave = useCallback((): void => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const pending = pendingRef.current
    pendingRef.current = null
    if (pending) writeGridLayout(hostId, pending)
  }, [hostId])

  /** Snapshot the arrangement now (the dock may be gone by the time it is written). */
  const scheduleSave = useCallback((): void => {
    const dv = apiRef.current
    if (!dv || !restoredRef.current || closingRef.current) return
    // an empty grid is never worth keeping over the last real arrangement
    if (dv.panels.length === 0) return
    try {
      pendingRef.current = { version: 1, mode: modeRef.current, dockview: dv.toJSON() }
    } catch {
      return // mid-teardown; keep the previous snapshot
    }
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(flushSave, SAVE_DEBOUNCE_MS)
  }, [flushSave])

  const arrange = useCallback(
    (next: GridMode, list: SessionMeta[]): void => {
      const dv = apiRef.current
      if (!dv || list.length === 0) return
      applySessionLayout(dv, list, { hostId, projectId: '__grid__', mode: next })
    },
    [hostId]
  )

  const addTile = useCallback(
    (dv: DockviewApi, s: SessionMeta, append: boolean): void => {
      const groups = dv.groups
      const last = groups.length > 0 ? groups[groups.length - 1] : undefined
      // appending gives the newcomer a tile of its own beside (or below) the
      // last one, leaving every existing tile where the user put it
      const group =
        append && last
          ? dv.addGroup({ referenceGroup: last, direction: modeRef.current === 'rows' ? 'below' : 'right' })
          : undefined
      dv.addPanel<GridPanelParams>({
        id: panelId('term', s.id),
        component: 'gridterm',
        title: s.tmuxName,
        params: { sessionId: s.id, hostId, projectId: s.projectId },
        renderer: 'always',
        ...(group ? { position: { referenceGroup: group, direction: 'within' as const } } : {})
      })
    },
    [hostId]
  )

  /** Bring the tiles in line with the sessions without moving the ones that stay. */
  const reconcile = useCallback(
    (dv: DockviewApi, failed: ReadonlySet<string>): void => {
      const refs: GridPanelRef[] = []
      for (const panel of dv.panels) {
        const parsed = parseSessionPanelId(panel.id)
        if (!parsed) continue
        const params = panel.params as Partial<GridPanelParams> | undefined
        refs.push({ sessionId: parsed.sessionId, projectId: params?.projectId ?? '' })
      }
      const plan = planGridReconcile(refs, sessions, failed)
      for (const sessionId of plan.remove) {
        const panel = dv.getPanel(panelId('term', sessionId))
        if (!panel) continue
        try {
          dv.removePanel(panel)
        } catch {
          // already disposed
        }
      }
      if (dv.panels.length === 0) {
        // nothing of the old arrangement survived: lay everything out afresh
        for (const s of plan.add) addTile(dv, s, false)
        arrange(modeRef.current, sessions)
      } else {
        for (const s of plan.add) addTile(dv, s, true)
      }
    },
    [addTile, arrange, sessions]
  )

  // first time everything is known: restore the saved arrangement, if any
  useEffect(() => {
    const dv = apiRef.current
    if (!dv || !ready || unloaded === null || restoredRef.current) return
    const saved = readGridLayout(hostId)
    if (saved) {
      try {
        dv.fromJSON(saved.dockview as never)
        // the layout stores params verbatim; refresh the host binding
        for (const panel of dv.panels) {
          if (parseSessionPanelId(panel.id)) panel.api.updateParameters({ hostId })
        }
      } catch {
        try {
          dv.clear()
        } catch {
          // already empty
        }
      }
    }
    reconcile(dv, unloaded)
    restoredRef.current = true
    scheduleSave()
  }, [ready, unloaded, hostId, reconcile, scheduleSave])

  // afterwards, sessions coming and going only add or remove their own tile
  useEffect(() => {
    const dv = apiRef.current
    if (!dv || !restoredRef.current || unloaded === null) return
    reconcile(dv, unloaded)
  }, [sessions, unloaded, reconcile])

  const changeMode = useCallback(
    (next: GridMode): void => {
      setMode(next)
      modeRef.current = next
      arrange(next, sessions)
      scheduleSave()
    },
    [arrange, scheduleSave, sessions]
  )

  const onReady = useCallback(
    (event: DockviewReadyEvent): void => {
      apiRef.current = event.api
      restoredRef.current = false
      event.api.onDidLayoutChange(() => scheduleSave())
      setReady(true)
    },
    [scheduleSave]
  )

  // layout-effect cleanups run before any passive one, so this stops snapshots
  // before dockview's own teardown starts removing panels one by one
  useLayoutEffect(() => {
    closingRef.current = false
    return () => {
      closingRef.current = true
    }
  }, [])

  // write the last arrangement out as the grid closes — or as the app quits,
  // which unloads the page without unmounting anything
  useEffect(() => {
    window.addEventListener('pagehide', flushSave)
    return () => {
      window.removeEventListener('pagehide', flushSave)
      flushSave()
      apiRef.current = null
    }
  }, [flushSave])

  const loading = unloaded === null
  const empty = !loading && sessions.length === 0

  return (
    <div style={{ height: '100%', width: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 30,
          padding: '0 8px',
          background: 'var(--ra-bg-raised)',
          borderBottom: '1px solid var(--ra-border)'
        }}
      >
        <span style={{ fontSize: 11.5, color: 'var(--ra-text-dim)' }}>
          {sessions.length} session{sessions.length === 1 ? '' : 's'} across{' '}
          {new Set(sessions.map((s) => s.projectId)).size} project
          {new Set(sessions.map((s) => s.projectId)).size === 1 ? '' : 's'}
        </span>
        <span style={{ fontSize: 11, color: 'var(--ra-text-faint)' }}>
          — drag a tile’s edge to resize, or drag its tab to split
        </span>
        <div style={{ flex: 1 }} />
        {GRID_MODES.map((m, i) => {
          const active = mode === m.value
          return (
            <button
              key={m.value}
              className='ra-btn'
              title={m.title}
              onClick={() => changeMode(m.value)}
              style={{
                padding: '1px 9px',
                fontSize: 11.5,
                borderRadius:
                  i === 0 ? '4px 0 0 4px' : i === GRID_MODES.length - 1 ? '0 4px 4px 0' : 0,
                marginLeft: i === 0 ? 0 : -1,
                background: active ? 'var(--ra-bg-active)' : 'var(--ra-bg-hover)',
                color: active ? 'var(--ra-text)' : 'var(--ra-text-dim)',
                borderColor: active ? 'var(--ra-accent)' : 'var(--ra-border-strong)',
                position: 'relative',
                zIndex: active ? 1 : 0
              }}
            >
              {m.label}
            </button>
          )
        })}
      </div>
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <DockviewReact
          className='dockview-theme-dark dockview-theme-ra ra-tiled'
          components={GRID_COMPONENTS}
          onReady={onReady}
        />
        {(loading || empty) && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--ra-text-dim)',
              fontSize: 13,
              textAlign: 'center',
              padding: 24,
              background: 'var(--ra-bg)'
            }}
          >
            {loading
              ? 'Loading sessions…'
              : 'No sessions running on this host yet. Create a session in any project and it will show up here.'}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * A grid tile: one session's terminal under a compact header that names the
 * project (in its accent colour) and the session, and jumps into that project
 * when clicked. Deliberately leaner than the workspace TerminalPanel — no
 * detach/kill/split controls, since the grid is a read-at-a-glance overview.
 */
const GridTerminalPanel: React.FC<IDockviewPanelProps<GridPanelParams>> = (props) => {
  const { sessionId, hostId, projectId } = props.params
  const session = useProjectsStore((s) =>
    (s.sessionsByProject[projectId] ?? []).find((x) => x.id === sessionId)
  )
  const projectName = useProjectsStore(
    (s) => s.projects.find((p) => p.id === projectId)?.name ?? 'project'
  )
  const setActiveProject = useProjectsStore((s) => s.setActiveProject)
  const closeGlobalGrid = useUiStore((s) => s.closeGlobalGrid)
  const accent = projectAccent(projectId)

  const openProject = (): void => {
    setActiveProject(projectId)
    closeGlobalGrid()
  }

  if (!session) {
    return (
      <div
        style={{
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--ra-text-dim)',
          fontSize: 12.5,
          ...frame(accent)
        }}
      >
        Session gone
      </div>
    )
  }

  const aliveColor =
    session.alive === true
      ? 'var(--ra-green)'
      : session.alive === false
        ? 'var(--ra-red)'
        : 'var(--ra-text-faint)'
  const aliveTitle =
    session.alive === true
      ? 'tmux session is running'
      : session.alive === false
        ? 'tmux session is not running'
        : 'tmux state unknown'

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', ...frame(accent) }}>
      <div
        onClick={openProject}
        title={`${session.tmuxName} — ${session.cwd}\nClick to open ${projectName}`}
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          padding: '4px 8px',
          cursor: 'pointer',
          background: 'var(--ra-bg-raised)',
          borderBottom: '1px solid var(--ra-border)',
          userSelect: 'none'
        }}
      >
        <span
          title={aliveTitle}
          style={{ width: 7, height: 7, borderRadius: '50%', background: aliveColor, flexShrink: 0 }}
        />
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            color: accent,
            flexShrink: 0,
            maxWidth: 120,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {projectName}
        </span>
        <span style={{ color: 'var(--ra-text-faint)' }}>/</span>
        <span
          style={{
            fontFamily: 'var(--ra-mono)',
            fontSize: 11.5,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap'
          }}
        >
          {session.tmuxName}
        </span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 9.5, color: AGENT_COLOR[session.agent], flexShrink: 0 }}>
          {session.agent}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <XtermView hostId={hostId} tmuxName={session.tmuxName} cwd={session.cwd} />
      </div>
    </div>
  )
}

/** Accent stripe framing a tile so its project stays legible after dragging. */
function frame(accent: string): React.CSSProperties {
  return { borderLeft: `3px solid ${accent}` }
}

const GRID_COMPONENTS: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {
  gridterm: GridTerminalPanel as React.FunctionComponent<IDockviewPanelProps>
}
