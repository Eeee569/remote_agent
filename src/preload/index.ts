import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { CH, RendererApi } from '../shared/ipc'
import type {
  BootstrapProgressEvent,
  ConnEvent,
  TermDataEvent,
  TermExitEvent
} from '../shared/domain'

function on<T>(channel: string) {
  return (cb: (e: T) => void): (() => void) => {
    const listener = (_evt: IpcRendererEvent, payload: T) => cb(payload)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  }
}

const api: RendererApi = {
  ping: () => ipcRenderer.invoke(CH.ping),

  hostsList: () => ipcRenderer.invoke(CH.hostsList),
  hostsSave: (input) => ipcRenderer.invoke(CH.hostsSave, input),
  hostsDelete: (hostId) => ipcRenderer.invoke(CH.hostsDelete, { hostId }),
  hostsTest: (input) => ipcRenderer.invoke(CH.hostsTest, input),

  connConnect: (hostId) => ipcRenderer.invoke(CH.connConnect, { hostId }),
  connDisconnect: (hostId) => ipcRenderer.invoke(CH.connDisconnect, { hostId }),
  connStatus: (hostId) => ipcRenderer.invoke(CH.connStatus, { hostId }),
  onConn: on<ConnEvent>(CH.evtConn),

  bootstrapStatus: (hostId) => ipcRenderer.invoke(CH.bootstrapStatus, { hostId }),
  bootstrapInstall: (hostId, targets) => ipcRenderer.invoke(CH.bootstrapInstall, { hostId, targets }),
  onBootstrapProgress: on<BootstrapProgressEvent>(CH.evtBootstrapProgress),

  termOpen: (input) => ipcRenderer.invoke(CH.termOpen, input),
  termWrite: (termId, data) => ipcRenderer.send(CH.termWrite, { termId, data }),
  termResize: (termId, cols, rows) => ipcRenderer.send(CH.termResize, { termId, cols, rows }),
  termClose: (termId) => ipcRenderer.invoke(CH.termClose, { termId }),
  onTermData: on<TermDataEvent>(CH.evtTermData),
  onTermExit: on<TermExitEvent>(CH.evtTermExit),

  fsLsTree: (hostId, path) => ipcRenderer.invoke(CH.fsLsTree, { hostId, path }),
  fsRead: (hostId, path, maxBytes) => ipcRenderer.invoke(CH.fsRead, { hostId, path, maxBytes }),
  fsWrite: (hostId, path, data, mode) => ipcRenderer.invoke(CH.fsWrite, { hostId, path, data, mode }),
  fsHome: (hostId) => ipcRenderer.invoke(CH.fsHome, { hostId }),
  gitStatus: (hostId, repoPath) => ipcRenderer.invoke(CH.gitStatus, { hostId, path: repoPath }),

  projectList: (hostId) => ipcRenderer.invoke(CH.projectList, { hostId }),
  projectAdd: (hostId, name, repoPath) => ipcRenderer.invoke(CH.projectAdd, { hostId, name, repoPath }),
  projectRemove: (hostId, projectId) => ipcRenderer.invoke(CH.projectRemove, { hostId, projectId }),

  sessionCreate: (hostId, projectId, spec) => ipcRenderer.invoke(CH.sessionCreate, { hostId, projectId, spec }),
  sessionList: (hostId, projectId) => ipcRenderer.invoke(CH.sessionList, { hostId, projectId }),
  sessionKill: (hostId, projectId, sessionId, opts) =>
    ipcRenderer.invoke(CH.sessionKill, { hostId, projectId, sessionId, ...opts }),

  worktreeList: (hostId, repoPath) => ipcRenderer.invoke(CH.worktreeList, { hostId, repoPath }),

  layoutRead: (hostId, projectId) => ipcRenderer.invoke(CH.layoutRead, { hostId, projectId }),
  layoutWrite: (hostId, projectId, layout) => ipcRenderer.invoke(CH.layoutWrite, { hostId, projectId, layout }),

  settingsRead: (target) => ipcRenderer.invoke(CH.settingsRead, target),
  settingsWrite: (target, content) => ipcRenderer.invoke(CH.settingsWrite, { ...target, content }),
  agentsList: (hostId, scope, projectPath) => ipcRenderer.invoke(CH.agentsList, { hostId, scope, projectPath }),
  agentsRead: (hostId, scope, name, projectPath) =>
    ipcRenderer.invoke(CH.agentsRead, { hostId, scope, name, projectPath }),
  agentsWrite: (hostId, scope, name, content, projectPath) =>
    ipcRenderer.invoke(CH.agentsWrite, { hostId, scope, name, content, projectPath }),
  agentsDelete: (hostId, scope, name, projectPath) =>
    ipcRenderer.invoke(CH.agentsDelete, { hostId, scope, name, projectPath }),
  codexWizardPreview: (opts) => ipcRenderer.invoke(CH.codexWizardPreview, opts),
  codexWizardApply: (opts) => ipcRenderer.invoke(CH.codexWizardApply, opts)
}

contextBridge.exposeInMainWorld('api', api)
