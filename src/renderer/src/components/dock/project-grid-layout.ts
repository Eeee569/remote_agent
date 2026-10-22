/**
 * Persistence for the Project Grid's arrangement. The grid spans every
 * project on a host, so it has no project to store its layout under on the
 * server; it is a per-machine view preference and lives in localStorage,
 * keyed by the (machine-local) host record id.
 */
import type { SessionLayoutMode, SessionMeta } from '@shared/domain'

export type GridMode = Extract<SessionLayoutMode, 'columns' | 'rows' | 'grid'>

export interface SavedGridLayout {
  version: 1
  mode: GridMode
  /** verbatim dockview api.toJSON() output */
  dockview: unknown
}

const KEY_PREFIX = 'ra.projectGrid.'
const MODES: readonly string[] = ['columns', 'rows', 'grid']

export function gridLayoutKey(hostId: string): string {
  return KEY_PREFIX + hostId
}

/** Validates a stored value; anything unrecognisable reads as "no layout". */
export function parseGridLayout(raw: string | null): SavedGridLayout | null {
  if (raw === null) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (v.version !== 1 || typeof v.mode !== 'string' || !MODES.includes(v.mode)) return null
  if (typeof v.dockview !== 'object' || v.dockview === null) return null
  return { version: 1, mode: v.mode as GridMode, dockview: v.dockview }
}

export function readGridLayout(hostId: string): SavedGridLayout | null {
  try {
    return parseGridLayout(window.localStorage.getItem(gridLayoutKey(hostId)))
  } catch {
    return null
  }
}

export function writeGridLayout(hostId: string, layout: SavedGridLayout): void {
  try {
    window.localStorage.setItem(gridLayoutKey(hostId), JSON.stringify(layout))
  } catch {
    // storage full or unavailable: the grid just reopens freshly arranged
  }
}

export interface GridPanelRef {
  sessionId: string
  projectId: string
}

export interface GridReconcilePlan {
  /** session ids whose tiles should go: the session or its project is gone */
  remove: string[]
  /** sessions with no tile yet, in display order, to append */
  add: SessionMeta[]
}

/**
 * What to change so the open tiles match the sessions that exist, without
 * moving anything that stays. A tile is kept when its session exists, and
 * also when its project failed to load this time — a transient error must
 * not erase that part of the arrangement.
 */
export function planGridReconcile(
  panels: readonly GridPanelRef[],
  sessions: readonly SessionMeta[],
  unloadedProjectIds: ReadonlySet<string>
): GridReconcilePlan {
  const known = new Set(sessions.map((s) => s.id))
  const present = new Set(panels.map((p) => p.sessionId))
  return {
    remove: panels
      .filter((p) => !known.has(p.sessionId) && !unloadedProjectIds.has(p.projectId))
      .map((p) => p.sessionId),
    add: sessions.filter((s) => !present.has(s.id))
  }
}
