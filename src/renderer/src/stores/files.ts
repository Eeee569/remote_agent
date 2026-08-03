import { create } from 'zustand'

/**
 * Per-session open files for the viewer panels. Keys are session ids; values
 * are absolute remote paths. Persisted (filtered per project) inside the
 * dockview layout blob by DockWorkspace.
 */
export interface FilesState {
  openBySession: Record<string, string[]>
  activeBySession: Record<string, string | null>
  openFile(sessionId: string, path: string): void
  closeFile(sessionId: string, path: string): void
  setActive(sessionId: string, path: string | null): void
  hydrate(map: Record<string, string[]>): void
}

export const useFilesStore = create<FilesState>()((set) => ({
  openBySession: {},
  activeBySession: {},

  openFile: (sessionId, path) =>
    set((s) => {
      const list = s.openBySession[sessionId] ?? []
      const openBySession = list.includes(path)
        ? s.openBySession
        : { ...s.openBySession, [sessionId]: [...list, path] }
      return { openBySession, activeBySession: { ...s.activeBySession, [sessionId]: path } }
    }),

  closeFile: (sessionId, path) =>
    set((s) => {
      const list = s.openBySession[sessionId] ?? []
      const idx = list.indexOf(path)
      if (idx === -1) return s
      const next = list.filter((p) => p !== path)
      const active = s.activeBySession[sessionId] ?? null
      const nextActive = active === path ? (next[Math.min(idx, next.length - 1)] ?? null) : active
      return {
        openBySession: { ...s.openBySession, [sessionId]: next },
        activeBySession: { ...s.activeBySession, [sessionId]: nextActive }
      }
    }),

  setActive: (sessionId, path) =>
    set((s) => ({ activeBySession: { ...s.activeBySession, [sessionId]: path } })),

  hydrate: (map) =>
    set((s) => {
      const openBySession = { ...s.openBySession }
      const activeBySession = { ...s.activeBySession }
      for (const [sessionId, paths] of Object.entries(map)) {
        const deduped = [...new Set(paths)]
        openBySession[sessionId] = deduped
        const current = activeBySession[sessionId]
        if (current === undefined || (current !== null && !deduped.includes(current))) {
          activeBySession[sessionId] = deduped[0] ?? null
        }
      }
      return { openBySession, activeBySession }
    })
}))
