/**
 * Session <-> dockview panel plumbing.
 *
 * Every panel in a project workspace belongs to exactly one session and is
 * named "<kind>:<sessionId>", so a session's panels can be found, titled,
 * arranged, and closed as one unit. The pure helpers at the top are unit
 * tested; the functions taking a DockviewApi drive the live workspace.
 */
import type { CSSProperties } from 'react'
import type { DockviewApi, DockviewGroupPanel, IDockviewPanel } from 'dockview'
import type { SessionLayoutMode, SessionMeta } from '@shared/domain'
import type { SessionPanelParams } from '@/components/dock/panels'

/** Panel kinds a session owns, in the order they are created/tabbed. */
export const SESSION_PANEL_KINDS = ['term', 'shell', 'tree', 'view'] as const
export type SessionPanelKind = (typeof SESSION_PANEL_KINDS)[number]

/** Prefix of the "session gone" placeholder left when a session vanishes. */
export const PLACEHOLDER_PREFIX = 'gone:'

const KINDS = new Set<string>(SESSION_PANEL_KINDS)

export function panelId(kind: SessionPanelKind, sessionId: string): string {
  return `${kind}:${sessionId}`
}

/** All four panel ids of a session, in tab order. */
export function sessionPanelIds(sessionId: string): string[] {
  return SESSION_PANEL_KINDS.map((k) => panelId(k, sessionId))
}

export function parseSessionPanelId(
  id: string
): { kind: SessionPanelKind; sessionId: string } | null {
  const at = id.indexOf(':')
  if (at <= 0) return null
  const kind = id.slice(0, at)
  const sessionId = id.slice(at + 1)
  if (!KINDS.has(kind) || sessionId === '') return null
  return { kind: kind as SessionPanelKind, sessionId }
}

/**
 * Tab titles. Tiled modes give each session its own group, so the session
 * name only needs to appear on the terminal tab — the rest stay short to
 * keep the tab strip from eating the tile.
 */
export function panelTitle(
  kind: SessionPanelKind,
  tmuxName: string,
  mode: SessionLayoutMode
): string {
  if (mode === 'focus') {
    switch (kind) {
      case 'term':
        return tmuxName
      case 'shell':
        return `Shell — ${tmuxName}`
      case 'tree':
        return `Files — ${tmuxName}`
      case 'view':
        return `Viewer — ${tmuxName}`
    }
  }
  switch (kind) {
    case 'term':
      return tmuxName
    case 'shell':
      return 'Shell'
    case 'tree':
      return 'Files'
    case 'view':
      return 'Viewer'
  }
}

/** Split direction that puts the next session beside/below the previous one. */
export function tileDirection(mode: SessionLayoutMode): 'right' | 'below' {
  return mode === 'rows' ? 'below' : 'right'
}

/** Sessions whose terminal panel the user has not closed, in creation order. */
export function visibleSessions(sessions: SessionMeta[], closed: ReadonlySet<string>): SessionMeta[] {
  return sessions.filter((s) => !closed.has(panelId('term', s.id)))
}

/**
 * Which session "focus" mode should show: the requested one when it is still
 * around and not closed, else the first session that is.
 */
export function resolveFocused(
  sessions: SessionMeta[],
  focusedSessionId: string | null,
  closed: ReadonlySet<string>
): string | null {
  const visible = visibleSessions(sessions, closed)
  if (focusedSessionId !== null && visible.some((s) => s.id === focusedSessionId)) {
    return focusedSessionId
  }
  return visible[0]?.id ?? null
}

/**
 * The sessions a mode puts on screen: exactly one in focus mode, every
 * session the user has not closed in the tiling modes.
 */
export function sessionsForMode(
  sessions: SessionMeta[],
  mode: SessionLayoutMode,
  focusedSessionId: string | null,
  closed: ReadonlySet<string>
): SessionMeta[] {
  const visible = visibleSessions(sessions, closed)
  if (mode !== 'focus') return visible
  const focused = visible.find((s) => s.id === resolveFocused(sessions, focusedSessionId, closed))
  return focused ? [focused] : []
}

/** Grid shape for `count` tiles: as square as possible, wider than tall. */
export function gridShape(count: number): { cols: number; rows: number } {
  if (count <= 0) return { cols: 0, rows: 0 }
  const cols = Math.ceil(Math.sqrt(count))
  return { cols, rows: Math.ceil(count / cols) }
}

/**
 * Stable per-session accent, used on every panel header of that session so
 * the windows of one session read as a set — especially when tiled.
 */
const ACCENTS = [
  '#3794ff', // blue
  '#89d185', // green
  '#c586c0', // purple
  '#ce9178', // orange
  '#4ec9b0', // teal
  '#e2c08d', // tan
  '#d670d6', // magenta
  '#f14c4c' // red
]

function accentFor(key: string): string {
  let hash = 0
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0
  }
  return ACCENTS[Math.abs(hash) % ACCENTS.length]
}

export function sessionAccent(sessionId: string): string {
  return accentFor(sessionId)
}

/**
 * Stable per-project accent, used to frame and label a project's sessions in
 * the cross-project grid so tiles of one project read as a set. Prefixed so a
 * project id can never collide with a session id in the same palette.
 */
export function projectAccent(projectId: string): string {
  return accentFor(`project:${projectId}`)
}

/** Accent stripe every session panel puts on its outermost element. */
export function sessionFrameStyle(sessionId: string): CSSProperties {
  return { borderLeft: `3px solid ${sessionAccent(sessionId)}` }
}

// ---------------- dockview operations ----------------

export interface SessionPanelContext {
  hostId: string
  projectId: string
  mode: SessionLayoutMode
}

const COMPONENT_BY_KIND: Record<SessionPanelKind, string> = {
  term: 'terminal',
  shell: 'shell',
  tree: 'tree',
  view: 'viewer'
}

/** Terminals stay mounted while their tab is hidden; they hold a live PTY. */
function rendererFor(kind: SessionPanelKind): 'always' | 'onlyWhenVisible' {
  return kind === 'term' || kind === 'shell' ? 'always' : 'onlyWhenVisible'
}

function panelsOf(dv: DockviewApi, sessionId: string): IDockviewPanel[] {
  const out: IDockviewPanel[] = []
  for (const id of sessionPanelIds(sessionId)) {
    const panel = dv.getPanel(id)
    if (panel) out.push(panel)
  }
  return out
}

/** First existing panel of `kind` belonging to any *other* session. */
function anchorOfKind(
  dv: DockviewApi,
  kind: SessionPanelKind,
  exceptSessionId: string
): IDockviewPanel | undefined {
  for (const panel of dv.panels) {
    const parsed = parseSessionPanelId(panel.id)
    if (parsed && parsed.kind === kind && parsed.sessionId !== exceptSessionId) return panel
  }
  return undefined
}

function lastGroup(dv: DockviewApi): DockviewGroupPanel | undefined {
  const groups = dv.groups
  return groups.length > 0 ? groups[groups.length - 1] : undefined
}

/**
 * Create the panels of one session. In focus mode panels join the matching
 * group of the sessions already open (terminal + shell left, files right,
 * viewer below); when tiled the session gets a group of its own.
 */
export function addSessionPanels(
  dv: DockviewApi,
  session: SessionMeta,
  ctx: SessionPanelContext,
  kinds: readonly SessionPanelKind[] = SESSION_PANEL_KINDS
): void {
  const params: SessionPanelParams = {
    sessionId: session.id,
    hostId: ctx.hostId,
    projectId: ctx.projectId
  }
  const missing = kinds.filter((k) => dv.getPanel(panelId(k, session.id)) === undefined)
  if (missing.length === 0) return

  let group: DockviewGroupPanel | undefined
  if (ctx.mode !== 'focus') {
    // reuse the session's own group when it already has panels, else append
    const existing = panelsOf(dv, session.id)[0]?.api.group
    if (existing) {
      group = existing
    } else {
      const reference = lastGroup(dv)
      group = reference
        ? dv.addGroup({ referenceGroup: reference, direction: tileDirection(ctx.mode) })
        : dv.addGroup()
    }
  }

  /** First of this session's own panels that exists, to anchor against. */
  const own = (candidates: SessionPanelKind[]): string | undefined =>
    candidates.map((k) => panelId(k, session.id)).find((pid) => dv.getPanel(pid) !== undefined)

  for (const kind of missing) {
    const id = panelId(kind, session.id)
    const title = panelTitle(kind, session.tmuxName, ctx.mode)
    const common = {
      id,
      component: COMPONENT_BY_KIND[kind],
      title,
      params,
      renderer: rendererFor(kind),
      // the shell is a companion tab: it must never take the terminal's place
      // when it is added to a session that already exists
      ...(kind === 'shell' ? { inactive: true } : {})
    }

    if (group) {
      dv.addPanel<SessionPanelParams>({
        ...common,
        position: { referenceGroup: group, direction: 'within' }
      })
      continue
    }

    // focus mode: sit with the same kind of panel from other sessions, else
    // fall back to this session's own panels to build the default frame
    const anchor = anchorOfKind(dv, kind, session.id)
    if (anchor) {
      dv.addPanel<SessionPanelParams>({
        ...common,
        position: { referencePanel: anchor.id, direction: 'within' }
      })
      continue
    }
    if (kind === 'term') {
      dv.addPanel<SessionPanelParams>(common)
      continue
    }
    const reference =
      kind === 'view' ? own(['tree', 'term', 'shell']) : own(['term', 'shell', 'tree'])
    if (reference === undefined) {
      // every sibling was closed — start a fresh frame for this session
      dv.addPanel<SessionPanelParams>(common)
      continue
    }
    const direction = kind === 'tree' ? 'right' : kind === 'view' ? 'below' : 'within'
    dv.addPanel<SessionPanelParams>({ ...common, position: { referencePanel: reference, direction } })
    if (kind === 'tree') sizeFilesColumn(dv, session.id)
  }

  try {
    dv.getPanel(panelId('term', session.id))?.api.setActive()
  } catch {
    // focusing is cosmetic
  }
}

/** Files/viewer column takes ~45% of the workspace width. */
function sizeFilesColumn(dv: DockviewApi, sessionId: string): void {
  try {
    const width = Math.round(dv.width * 0.45)
    if (width > 0) dv.getPanel(panelId('tree', sessionId))?.api.setSize({ width })
  } catch {
    // dockview sizing APIs vary; layout is still usable
  }
}

/**
 * Close every panel of a session (including its placeholder). Returns the
 * ids that were actually closed.
 */
export function closeSessionPanels(
  dv: DockviewApi,
  sessionId: string,
  opts: { keepPlaceholder?: boolean } = {}
): string[] {
  const closed: string[] = []
  for (const panel of panelsOf(dv, sessionId)) {
    closed.push(panel.id)
    try {
      dv.removePanel(panel)
    } catch {
      // panel already disposed
    }
  }
  const gone = opts.keepPlaceholder ? undefined : dv.getPanel(PLACEHOLDER_PREFIX + sessionId)
  if (gone) {
    try {
      dv.removePanel(gone)
    } catch {
      // already disposed
    }
  }
  return closed
}

function moveTo(panel: IDockviewPanel, group: DockviewGroupPanel): void {
  if (panel.api.group === group) return
  try {
    panel.api.moveTo({ group, position: 'center', skipSetActive: true })
  } catch {
    // a panel disposed mid-rearrange just stays where it is
  }
}

function retitle(panel: IDockviewPanel, tmuxName: string, mode: SessionLayoutMode): void {
  const parsed = parseSessionPanelId(panel.id)
  if (!parsed) return
  try {
    panel.api.setTitle(panelTitle(parsed.kind, tmuxName, mode))
  } catch {
    // title is cosmetic
  }
}

/** True when the group holds a panel that is not one of `sessionId`'s. */
function hasForeignPanels(group: DockviewGroupPanel, sessionId: string): boolean {
  return group.panels.some((p) => {
    const parsed = parseSessionPanelId(p.id)
    return parsed === null || parsed.sessionId !== sessionId
  })
}

/**
 * Rearrange all existing session panels into `ctx.mode`. Sessions must be
 * passed in the order they should appear; panels that do not exist are
 * skipped (nothing is created here).
 */
export function applySessionLayout(
  dv: DockviewApi,
  sessions: SessionMeta[],
  ctx: SessionPanelContext
): void {
  for (const s of sessions) {
    for (const panel of panelsOf(dv, s.id)) retitle(panel, s.tmuxName, ctx.mode)
  }
  if (ctx.mode === 'focus') applyFocusLayout(dv, sessions)
  else if (ctx.mode === 'grid') applyGridLayout(dv, sessions)
  else applyTiledLayout(dv, sessions, ctx.mode)
}

function applyFocusLayout(dv: DockviewApi, sessions: SessionMeta[], sizeFiles = true): void {
  let termGroup: DockviewGroupPanel | undefined
  let treeGroup: DockviewGroupPanel | undefined
  let viewGroup: DockviewGroupPanel | undefined

  for (const s of sessions) {
    const term = dv.getPanel(panelId('term', s.id))
    const shell = dv.getPanel(panelId('shell', s.id))
    const tree = dv.getPanel(panelId('tree', s.id))
    const view = dv.getPanel(panelId('view', s.id))

    if (!termGroup) termGroup = term?.api.group ?? shell?.api.group
    if (termGroup) {
      if (term) moveTo(term, termGroup)
      if (shell) moveTo(shell, termGroup)
    }

    // the files column and viewer need groups of their own: when coming from a
    // tiled layout the panel is still sitting in a group claimed above
    if (!treeGroup && tree) {
      treeGroup =
        tree.api.group === termGroup
          ? dv.addGroup({ referenceGroup: termGroup, direction: 'right' })
          : tree.api.group
    }
    if (tree && treeGroup) moveTo(tree, treeGroup)

    if (!viewGroup && view) {
      const own = view.api.group
      const reference = treeGroup ?? termGroup
      viewGroup =
        (own === termGroup || own === treeGroup) && reference
          ? dv.addGroup({ referenceGroup: reference, direction: 'below' })
          : own
    }
    if (view && viewGroup) moveTo(view, viewGroup)
  }

  const first = sessions[0]
  if (first && sizeFiles) sizeFilesColumn(dv, first.id)
  activateTerminals(dv, sessions)
}

/**
 * One cell per session, laid out as a near-square grid. Row bands are split
 * off first while each is still full width, then each band is split into its
 * cells — splitting a cell downwards would only divide that column.
 */
function applyGridLayout(dv: DockviewApi, sessions: SessionMeta[]): void {
  const placeable = sessions.filter((s) => panelsOf(dv, s.id).length > 0)
  const { cols, rows } = gridShape(placeable.length)
  if (cols === 0) return
  if (rows === 1) {
    applyTiledLayout(dv, placeable, 'columns')
    return
  }

  const firstPanels = panelsOf(dv, placeable[0].id)
  const firstOwn = firstPanels[0].api.group
  const rowAnchors: DockviewGroupPanel[] = [
    hasForeignPanels(firstOwn, placeable[0].id)
      ? dv.addGroup({ referenceGroup: firstOwn, direction: 'right' })
      : firstOwn
  ]
  for (let r = 1; r < rows; r++) {
    rowAnchors.push(dv.addGroup({ referenceGroup: rowAnchors[r - 1], direction: 'below' }))
  }

  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(cols, placeable.length - r * cols)
    let previous = rowAnchors[r]
    for (let c = 0; c < inRow; c++) {
      const group =
        c === 0 ? rowAnchors[r] : dv.addGroup({ referenceGroup: previous, direction: 'right' })
      for (const panel of panelsOf(dv, placeable[r * cols + c].id)) moveTo(panel, group)
      previous = group
      try {
        group.api.setSize({
          width: Math.floor(dv.width / inRow),
          height: Math.floor(dv.height / rows)
        })
      } catch {
        // best-effort: sizing failures leave usable (uneven) tiles
      }
    }
  }
  activateTerminals(dv, placeable)
}

/**
 * Split a session's own panels apart inside whatever space it already has:
 * terminal (+ shell tab) beside the files tree, viewer underneath. Used to
 * open one tile up without disturbing the other tiles.
 */
export function expandSessionPanels(dv: DockviewApi, session: SessionMeta): void {
  applyFocusLayout(dv, [session], false)
}

/** Put a session's panels back together as tabs of a single group. */
export function collapseSessionPanels(dv: DockviewApi, session: SessionMeta): void {
  const panels = panelsOf(dv, session.id)
  if (panels.length === 0) return
  const group = dv.getPanel(panelId('term', session.id))?.api.group ?? panels[0].api.group
  for (const panel of panels) moveTo(panel, group)
  activateTerminals(dv, [session])
}

/** True when every open panel of the session shares one group (tabbed). */
export function isSessionTabbed(dv: DockviewApi, sessionId: string): boolean {
  const panels = panelsOf(dv, sessionId)
  if (panels.length < 2) return true
  const group = panels[0].api.group
  return panels.every((p) => p.api.group === group)
}

/** How many of a session's panels are currently open. */
export function openPanelCount(dv: DockviewApi, sessionId: string): number {
  return panelsOf(dv, sessionId).length
}

function applyTiledLayout(
  dv: DockviewApi,
  sessions: SessionMeta[],
  mode: SessionLayoutMode
): void {
  const direction = tileDirection(mode)
  const groups: DockviewGroupPanel[] = []
  let previous: DockviewGroupPanel | undefined

  for (const s of sessions) {
    const panels = panelsOf(dv, s.id)
    if (panels.length === 0) continue

    let group: DockviewGroupPanel
    if (previous) {
      group = dv.addGroup({ referenceGroup: previous, direction })
    } else {
      const own = panels[0].api.group
      // the first session keeps its group unless it is shared with others
      group = hasForeignPanels(own, s.id) ? dv.addGroup({ referenceGroup: own, direction }) : own
    }
    for (const panel of panels) moveTo(panel, group)
    groups.push(group)
    previous = group
  }

  // dockview halves the reference group on every split, so even the tiles out
  if (groups.length > 1) {
    const total = direction === 'right' ? dv.width : dv.height
    const each = Math.floor(total / groups.length)
    if (each > 0) {
      for (const group of groups) {
        try {
          group.api.setSize(direction === 'right' ? { width: each } : { height: each })
        } catch {
          // best-effort: sizing failures leave usable (uneven) tiles
        }
      }
    }
  }
  activateTerminals(dv, sessions)
}

/** Make the terminal the visible tab of each session's group. */
function activateTerminals(dv: DockviewApi, sessions: SessionMeta[]): void {
  for (const s of sessions) {
    try {
      dv.getPanel(panelId('term', s.id))?.api.setActive()
    } catch {
      // cosmetic
    }
  }
}
