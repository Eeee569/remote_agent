import { useState } from 'react'
import type { AgentKind, SessionSpec } from '@shared/domain'
import { TMUX_PREFIX } from '@shared/helper-protocol'
import RemoteDirPicker from '@/components/common/RemoteDirPicker'
import { useConnectionStore } from '@/stores/connection'
import { useProjectsStore } from '@/stores/projects'
import { useUiStore } from '@/stores/ui'

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function basename(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() ?? ''
}

const AGENT_LABELS: Array<{ value: AgentKind; label: string }> = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'OpenAI Codex' },
  { value: 'shell', label: 'Plain shell' }
]

export default function NewSessionDialog(): React.JSX.Element | null {
  const hostId = useConnectionStore((s) => s.activeHostId)
  const project = useProjectsStore((s) =>
    s.activeProjectId ? s.projects.find((p) => p.id === s.activeProjectId) : undefined
  )
  const createSession = useProjectsStore((s) => s.createSession)
  const loadSessions = useProjectsStore((s) => s.loadSessions)
  const closeNewSession = useUiStore((s) => s.closeNewSession)
  const addToast = useUiStore((s) => s.addToast)

  const [agent, setAgent] = useState<AgentKind>('claude')
  const [mode, setMode] = useState<'worktree' | 'dir'>('worktree')
  const [branch, setBranch] = useState('')
  const [baseRef, setBaseRef] = useState('')
  const [dir, setDir] = useState(project?.repoPath ?? '')
  const [tmuxName, setTmuxName] = useState('')
  const [tmuxTouched, setTmuxTouched] = useState(false)
  const [launchCommand, setLaunchCommand] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  if (!hostId || !project) return null

  const suffix = slug(mode === 'worktree' ? branch : basename(dir))
  const suggested = `${TMUX_PREFIX}${slug(project.name)}${suffix ? `-${suffix}` : ''}`
  const effectiveTmuxName = tmuxTouched ? tmuxName : suggested

  const valid =
    effectiveTmuxName.trim() !== '' &&
    (mode === 'worktree' ? branch.trim() !== '' : dir.trim() !== '')

  const submit = async (): Promise<void> => {
    const spec: SessionSpec = {
      agent,
      mode,
      tmuxName: effectiveTmuxName.trim(),
      launchCommand: launchCommand.trim() || undefined,
      ...(mode === 'worktree'
        ? { branch: branch.trim(), baseRef: baseRef.trim() || undefined }
        : { dir: dir.trim() })
    }
    setBusy(true)
    try {
      const meta = await createSession(hostId, project.id, spec)
      addToast('success', `Session "${meta.tmuxName}" created`)
      await loadSessions(hostId, project.id)
      closeNewSession()
    } catch {
      // store already toasted the error; keep the dialog open
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className='ra-dialog-backdrop'
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeNewSession()
      }}
    >
      <div className='ra-dialog' style={{ width: 520 }}>
        <h2>New session — {project.name}</h2>

        <div style={{ marginBottom: 12 }}>
          <label className='ra-label'>Agent</label>
          <select
            className='ra-input'
            style={{ width: '100%' }}
            value={agent}
            onChange={(e) => setAgent(e.target.value as AgentKind)}
          >
            {AGENT_LABELS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label className='ra-label'>Location</label>
          <div style={{ display: 'flex', gap: 16, padding: '4px 0' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type='radio'
                name='ra-session-mode'
                checked={mode === 'worktree'}
                onChange={() => setMode('worktree')}
              />
              New git worktree
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input
                type='radio'
                name='ra-session-mode'
                checked={mode === 'dir'}
                onChange={() => setMode('dir')}
              />
              Existing directory
            </label>
          </div>
        </div>

        {mode === 'worktree' ? (
          <>
            <div style={{ marginBottom: 12, display: 'flex', gap: 10 }}>
              <div style={{ flex: 1 }}>
                <label className='ra-label'>Branch name</label>
                <input
                  className='ra-input'
                  style={{ width: '100%', fontFamily: 'var(--ra-mono)', fontSize: 12 }}
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder='feature/my-change'
                  spellCheck={false}
                  autoFocus
                />
              </div>
              <div style={{ flex: 1 }}>
                <label className='ra-label'>Base ref</label>
                <input
                  className='ra-input'
                  style={{ width: '100%', fontFamily: 'var(--ra-mono)', fontSize: 12 }}
                  value={baseRef}
                  onChange={(e) => setBaseRef(e.target.value)}
                  placeholder='HEAD'
                  spellCheck={false}
                />
              </div>
            </div>
            <div
              style={{
                marginBottom: 12,
                fontSize: 11.5,
                color: 'var(--ra-text-faint)',
                fontFamily: 'var(--ra-mono)',
                wordBreak: 'break-all'
              }}
            >
              → ~/.remote-agent/worktrees/{project.id}/{branch.trim() || '<branch>'}
            </div>
          </>
        ) : (
          <div style={{ marginBottom: 12 }}>
            <label className='ra-label'>Directory (on server)</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className='ra-input'
                style={{ flex: 1, fontFamily: 'var(--ra-mono)', fontSize: 12 }}
                value={dir}
                onChange={(e) => setDir(e.target.value)}
                spellCheck={false}
              />
              <button className='ra-btn' onClick={() => setPickerOpen(true)}>
                Browse…
              </button>
            </div>
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <label className='ra-label'>tmux session name</label>
          <input
            className='ra-input'
            style={{ width: '100%', fontFamily: 'var(--ra-mono)', fontSize: 12 }}
            value={effectiveTmuxName}
            onChange={(e) => {
              setTmuxTouched(true)
              setTmuxName(e.target.value)
            }}
            spellCheck={false}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <span
            onClick={() => setShowAdvanced((v) => !v)}
            style={{ cursor: 'pointer', fontSize: 12, color: 'var(--ra-text-dim)', userSelect: 'none' }}
          >
            {showAdvanced ? '▾' : '▸'} Advanced
          </span>
          {showAdvanced && (
            <div style={{ marginTop: 8 }}>
              <label className='ra-label'>Launch command override</label>
              <input
                className='ra-input'
                style={{ width: '100%', fontFamily: 'var(--ra-mono)', fontSize: 12 }}
                value={launchCommand}
                onChange={(e) => setLaunchCommand(e.target.value)}
                placeholder={
                  agent === 'claude' ? 'claude' : agent === 'codex' ? 'codex' : 'login shell'
                }
                spellCheck={false}
              />
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className='ra-btn' onClick={closeNewSession}>
            Cancel
          </button>
          <button className='ra-btn primary' disabled={!valid || busy} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create session'}
          </button>
        </div>
      </div>

      {pickerOpen && (
        <RemoteDirPicker
          hostId={hostId}
          initialPath={dir.trim() || project.repoPath}
          dirsOnly
          onClose={() => setPickerOpen(false)}
          onPick={(p) => {
            setDir(p)
            setPickerOpen(false)
          }}
        />
      )}
    </div>
  )
}
