/**
 * Dockview panel component registry + the param shapes panels receive.
 * Panel params must stay minimal, serializable objects: they are embedded
 * verbatim in the persisted dockview layout JSON on the server.
 */
import type { IDockviewPanelProps } from 'dockview'
import TerminalPanel from '@/components/terminal/TerminalPanel'
import FileTreePanel from '@/components/files/FileTreePanel'
import FileViewerPanel from '@/components/files/FileViewerPanel'
import SettingsPanel from '@/components/settings/SettingsPanel'
import InstallPanel from '@/components/settings/InstallPanel'
import PlaceholderPanel from '@/components/dock/PlaceholderPanel'

/** Params carried by every per-session panel (terminal / tree / viewer). */
export interface SessionPanelParams {
  sessionId: string
  hostId: string
  projectId: string
}

/** Params for the "session gone" placeholder that replaces stale panels. */
export interface PlaceholderPanelParams {
  sessionId: string
  title: string
}

export const panelComponents: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {
  terminal: TerminalPanel,
  tree: FileTreePanel,
  viewer: FileViewerPanel,
  settings: SettingsPanel,
  install: InstallPanel,
  placeholder: PlaceholderPanel
}
