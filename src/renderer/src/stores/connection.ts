import { create } from 'zustand'
import type { ConnEvent, HostPublic, HostSaveInput } from '@shared/domain'
import { api } from '@/api'
import { useUiStore } from '@/stores/ui'
import { useProjectsStore } from '@/stores/projects'

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface ConnectionState {
  hosts: HostPublic[]
  activeHostId: string | null
  statusByHost: Record<string, ConnEvent>
  refreshHosts(): Promise<void>
  saveHost(input: HostSaveInput): Promise<void>
  deleteHost(id: string): Promise<void>
  setActiveHost(id: string | null): void
  connect(hostId: string): Promise<void>
  disconnect(hostId: string): Promise<void>
}

export const useConnectionStore = create<ConnectionState>()((set, get) => ({
  hosts: [],
  activeHostId: null,
  statusByHost: {},

  refreshHosts: async () => {
    try {
      const hosts = await api.hostsList()
      set({ hosts })
      const { activeHostId } = get()
      if (activeHostId && !hosts.some((h) => h.id === activeHostId)) {
        set({ activeHostId: null })
      }
    } catch (err) {
      useUiStore.getState().addToast('error', `Failed to load hosts: ${errText(err)}`)
    }
  },

  saveHost: async (input) => {
    try {
      await api.hostsSave(input)
      await get().refreshHosts()
    } catch (err) {
      useUiStore.getState().addToast('error', `Failed to save host: ${errText(err)}`)
      throw err
    }
  },

  deleteHost: async (id) => {
    try {
      await api.hostsDelete(id)
      set((s) => {
        const statusByHost = { ...s.statusByHost }
        delete statusByHost[id]
        return {
          statusByHost,
          activeHostId: s.activeHostId === id ? null : s.activeHostId
        }
      })
      await get().refreshHosts()
    } catch (err) {
      useUiStore.getState().addToast('error', `Failed to delete host: ${errText(err)}`)
    }
  },

  setActiveHost: (id) => {
    if (get().activeHostId === id) return
    set({ activeHostId: id })
    // projects belong to a host; reset the projects store on host switch and
    // reload immediately when the newly active host is already connected
    useProjectsStore.setState({ projects: [], activeProjectId: null, sessionsByProject: {} })
    if (id && get().statusByHost[id]?.status === 'connected') {
      void useProjectsStore.getState().loadProjects(id)
    }
  },

  connect: async (hostId) => {
    set((s) => ({
      statusByHost: { ...s.statusByHost, [hostId]: { hostId, status: 'connecting' } }
    }))
    try {
      const status = await api.connConnect(hostId)
      set((s) => ({ statusByHost: { ...s.statusByHost, [hostId]: { hostId, status } } }))
      // pick up the TOFU-pinned fingerprint recorded on first connect
      void get().refreshHosts()
      await useProjectsStore.getState().loadProjects(hostId)
    } catch (err) {
      const message = errText(err)
      set((s) => ({
        statusByHost: { ...s.statusByHost, [hostId]: { hostId, status: 'failed', error: message } }
      }))
      useUiStore.getState().addToast('error', `Connection failed: ${message}`)
    }
  },

  disconnect: async (hostId) => {
    try {
      await api.connDisconnect(hostId)
      set((s) => ({
        statusByHost: { ...s.statusByHost, [hostId]: { hostId, status: 'idle' } }
      }))
    } catch (err) {
      useUiStore.getState().addToast('error', `Disconnect failed: ${errText(err)}`)
    }
  }
}))

let connEventsInitialized = false

/** Subscribe to main-process connection events exactly once (call from App). */
export function initConnectionEvents(): void {
  if (connEventsInitialized) return
  connEventsInitialized = true
  api.onConn((e) => {
    useConnectionStore.setState((s) => ({
      statusByHost: { ...s.statusByHost, [e.hostId]: e }
    }))
  })
}
