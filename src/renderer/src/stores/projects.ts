import { create } from 'zustand'
import type { ProjectMeta, SessionMeta, SessionSpec } from '@shared/domain'
import { api } from '@/api'
import { useUiStore } from '@/stores/ui'

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

interface ProjectsState {
  projects: ProjectMeta[]
  activeProjectId: string | null
  sessionsByProject: Record<string, SessionMeta[]>
  loadProjects(hostId: string): Promise<void>
  addProject(hostId: string, name: string, repoPath: string): Promise<void>
  removeProject(hostId: string, projectId: string): Promise<void>
  setActiveProject(id: string | null): void
  loadSessions(hostId: string, projectId: string): Promise<void>
  createSession(hostId: string, projectId: string, spec: SessionSpec): Promise<SessionMeta>
  killSession(
    hostId: string,
    projectId: string,
    sessionId: string,
    alsoRemoveWorktree?: boolean
  ): Promise<void>
}

export const useProjectsStore = create<ProjectsState>()((set, get) => ({
  projects: [],
  activeProjectId: null,
  sessionsByProject: {},

  loadProjects: async (hostId) => {
    try {
      const projects = await api.projectList(hostId)
      set({ projects })
      const { activeProjectId } = get()
      if (
        activeProjectId &&
        activeProjectId !== '__settings__' &&
        !projects.some((p) => p.id === activeProjectId)
      ) {
        set({ activeProjectId: null })
      }
    } catch (err) {
      useUiStore.getState().addToast('error', `Failed to load projects: ${errText(err)}`)
    }
  },

  addProject: async (hostId, name, repoPath) => {
    try {
      const meta = await api.projectAdd(hostId, name, repoPath)
      set((s) => ({
        projects: [...s.projects.filter((p) => p.id !== meta.id), meta],
        activeProjectId: meta.id
      }))
      await get().loadSessions(hostId, meta.id)
    } catch (err) {
      useUiStore.getState().addToast('error', `Failed to add project: ${errText(err)}`)
      throw err
    }
  },

  removeProject: async (hostId, projectId) => {
    try {
      await api.projectRemove(hostId, projectId)
      set((s) => {
        const sessionsByProject = { ...s.sessionsByProject }
        delete sessionsByProject[projectId]
        return {
          projects: s.projects.filter((p) => p.id !== projectId),
          activeProjectId: s.activeProjectId === projectId ? null : s.activeProjectId,
          sessionsByProject
        }
      })
    } catch (err) {
      useUiStore.getState().addToast('error', `Failed to remove project: ${errText(err)}`)
    }
  },

  setActiveProject: (id) => set({ activeProjectId: id }),

  loadSessions: async (hostId, projectId) => {
    try {
      const sessions = await api.sessionList(hostId, projectId)
      set((s) => ({ sessionsByProject: { ...s.sessionsByProject, [projectId]: sessions } }))
    } catch (err) {
      useUiStore.getState().addToast('error', `Failed to load sessions: ${errText(err)}`)
    }
  },

  createSession: async (hostId, projectId, spec) => {
    try {
      const meta = await api.sessionCreate(hostId, projectId, spec)
      set((s) => ({
        sessionsByProject: {
          ...s.sessionsByProject,
          [projectId]: [...(s.sessionsByProject[projectId] ?? []).filter((x) => x.id !== meta.id), meta]
        }
      }))
      return meta
    } catch (err) {
      useUiStore.getState().addToast('error', `Failed to create session: ${errText(err)}`)
      throw err
    }
  },

  killSession: async (hostId, projectId, sessionId, alsoRemoveWorktree) => {
    try {
      await api.sessionKill(hostId, projectId, sessionId, { alsoRemoveWorktree })
      set((s) => ({
        sessionsByProject: {
          ...s.sessionsByProject,
          [projectId]: (s.sessionsByProject[projectId] ?? []).filter((x) => x.id !== sessionId)
        }
      }))
    } catch (err) {
      useUiStore.getState().addToast('error', `Failed to kill session: ${errText(err)}`)
    }
  }
}))
