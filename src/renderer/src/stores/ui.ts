import { create } from 'zustand'

export type ToastKind = 'info' | 'error' | 'success'

export interface Toast {
  id: string
  kind: ToastKind
  text: string
}

interface UiState {
  toasts: Toast[]
  addToast(kind: ToastKind, text: string): void
  dismissToast(id: string): void

  hostFormOpen: boolean
  /** host id being edited, or null when adding a new host */
  hostFormEditingId: string | null
  openHostForm(editingId?: string | null): void
  closeHostForm(): void

  hostManagerOpen: boolean
  openHostManager(): void
  closeHostManager(): void

  addProjectOpen: boolean
  openAddProject(): void
  closeAddProject(): void

  newSessionOpen: boolean
  openNewSession(): void
  closeNewSession(): void

  /** cross-project overview: every running session on the host in one grid */
  globalGridOpen: boolean
  openGlobalGrid(): void
  closeGlobalGrid(): void
  toggleGlobalGrid(): void
}

export const useUiStore = create<UiState>()((set, get) => ({
  toasts: [],
  addToast: (kind, text) => {
    const id = crypto.randomUUID()
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }))
    setTimeout(() => get().dismissToast(id), 5000)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  hostFormOpen: false,
  hostFormEditingId: null,
  openHostForm: (editingId = null) => set({ hostFormOpen: true, hostFormEditingId: editingId }),
  closeHostForm: () => set({ hostFormOpen: false, hostFormEditingId: null }),

  hostManagerOpen: false,
  openHostManager: () => set({ hostManagerOpen: true }),
  closeHostManager: () => set({ hostManagerOpen: false }),

  addProjectOpen: false,
  openAddProject: () => set({ addProjectOpen: true }),
  closeAddProject: () => set({ addProjectOpen: false }),

  newSessionOpen: false,
  openNewSession: () => set({ newSessionOpen: true }),
  closeNewSession: () => set({ newSessionOpen: false }),

  globalGridOpen: false,
  openGlobalGrid: () => set({ globalGridOpen: true }),
  closeGlobalGrid: () => set({ globalGridOpen: false }),
  toggleGlobalGrid: () => set((s) => ({ globalGridOpen: !s.globalGridOpen }))
}))
