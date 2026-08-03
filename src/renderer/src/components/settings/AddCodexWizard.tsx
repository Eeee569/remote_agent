/**
 * Two-step wizard that wires OpenAI Codex into a project as a Claude Code
 * sub-agent: preview the file changes as Monaco diffs, then apply them via
 * the main-process codex wizard.
 */
import { useEffect, useRef, useState } from 'react'
import type * as monacoNs from 'monaco-editor'
import type { CodexWizardOptions, FileDiff } from '@shared/domain'
import { api } from '@/api'
import { useUiStore } from '@/stores/ui'
import { errText } from './settings-util'

function languageFor(path: string): string {
  if (path.endsWith('.json')) return 'json'
  if (path.endsWith('.md')) return 'markdown'
  return 'plaintext'
}

function DiffView({ diff }: { diff: FileDiff }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let disposed = false
    let editor: monacoNs.editor.IStandaloneDiffEditor | null = null
    let original: monacoNs.editor.ITextModel | null = null
    let modified: monacoNs.editor.ITextModel | null = null
    void (async () => {
      const { getMonaco } = await import('@/monaco-setup')
      if (disposed || !hostRef.current) return
      const monaco = getMonaco()
      original = monaco.editor.createModel(diff.before, languageFor(diff.path))
      modified = monaco.editor.createModel(diff.after, languageFor(diff.path))
      editor = monaco.editor.createDiffEditor(hostRef.current, {
        theme: 'ra-dark',
        readOnly: true,
        renderSideBySide: false,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 12,
        renderOverviewRuler: false
      })
      editor.setModel({ original, modified })
    })()
    return () => {
      disposed = true
      editor?.dispose()
      original?.dispose()
      modified?.dispose()
    }
  }, [diff])

  return (
    <div
      ref={hostRef}
      style={{
        height: 240,
        border: '1px solid var(--ra-border)',
        borderRadius: 'var(--ra-radius)',
        overflow: 'hidden'
      }}
    />
  )
}

function DiffCard({ diff }: { diff: FileDiff }): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const isNew = diff.before === ''
  return (
    <div
      style={{
        border: '1px solid var(--ra-border)',
        borderRadius: 8,
        marginBottom: 10,
        overflow: 'hidden'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          background: 'var(--ra-bg-hover)',
          cursor: 'pointer',
          userSelect: 'none'
        }}
        onClick={() => setOpen((v) => !v)}
      >
        <span style={{ color: 'var(--ra-text-faint)', fontSize: 11 }}>{open ? '▾' : '▸'}</span>
        <span style={{ fontFamily: 'var(--ra-mono)', fontSize: 12, wordBreak: 'break-all' }}>
          {diff.path}
        </span>
        {isNew && (
          <span style={{ fontSize: 10.5, color: 'var(--ra-green)', border: '1px solid var(--ra-green)', borderRadius: 999, padding: '0 7px' }}>
            new file
          </span>
        )}
      </div>
      {open && (
        <div style={{ padding: 8 }}>
          <DiffView diff={diff} />
        </div>
      )}
    </div>
  )
}

export interface AddCodexWizardProps {
  hostId: string
  repoPath: string
  onClose: () => void
}

export default function AddCodexWizard({ hostId, repoPath, onClose }: AddCodexWizardProps): React.JSX.Element {
  const addToast = useUiStore((s) => s.addToast)
  const [command, setCommand] = useState('codex')
  const [argsText, setArgsText] = useState('mcp-server')
  const [writeAgent, setWriteAgent] = useState(true)
  const [patchSettings, setPatchSettings] = useState(true)
  const [step, setStep] = useState<'form' | 'preview'>('form')
  const [diffs, setDiffs] = useState<FileDiff[] | null>(null)
  const [busy, setBusy] = useState(false)

  const buildOpts = (): CodexWizardOptions => ({
    hostId,
    projectPath: repoPath,
    command: command.trim() === '' ? 'codex' : command.trim(),
    args: argsText.split(/\s+/).filter((s) => s !== ''),
    writeAgentFile: writeAgent,
    patchSettings
  })

  const preview = async (): Promise<void> => {
    setBusy(true)
    try {
      setDiffs(await api.codexWizardPreview(buildOpts()))
      setStep('preview')
    } catch (err) {
      addToast('error', `Codex wizard preview failed: ${errText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const apply = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await api.codexWizardApply(buildOpts())
      addToast(
        'success',
        res.filesChanged.length > 0
          ? `Codex sub-agent configured — updated ${res.filesChanged.join(', ')}`
          : 'Codex sub-agent: no changes were needed'
      )
      onClose()
    } catch (err) {
      addToast('error', `Codex wizard failed: ${errText(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className='ra-dialog-backdrop'
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className='ra-dialog' style={{ width: 640 }}>
        <h2>Add Codex sub-agent</h2>

        {step === 'form' ? (
          <>
            <p style={{ margin: '0 0 14px', color: 'var(--ra-text-dim)', lineHeight: 1.5 }}>
              Claude Code orchestrates; Codex executes as a sub-agent via MCP. This registers a
              Codex MCP server in the project&apos;s .mcp.json and (optionally) a codex-worker agent
              plus the settings entries that let Claude delegate to it.
            </p>

            <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <label className='ra-label'>MCP command</label>
                <input
                  className='ra-input'
                  style={{ width: '100%', fontFamily: 'var(--ra-mono)', fontSize: 12 }}
                  value={command}
                  spellCheck={false}
                  onChange={(e) => setCommand(e.target.value)}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label className='ra-label'>Args (space-separated)</label>
                <input
                  className='ra-input'
                  style={{ width: '100%', fontFamily: 'var(--ra-mono)', fontSize: 12 }}
                  value={argsText}
                  spellCheck={false}
                  onChange={(e) => setArgsText(e.target.value)}
                />
              </div>
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, cursor: 'pointer' }}>
              <input type='checkbox' checked={writeAgent} onChange={(e) => setWriteAgent(e.target.checked)} />
              <span style={{ fontSize: 12.5 }}>Write codex-worker agent file (.claude/agents/codex-worker.md)</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, cursor: 'pointer' }}>
              <input
                type='checkbox'
                checked={patchSettings}
                onChange={(e) => setPatchSettings(e.target.checked)}
              />
              <span style={{ fontSize: 12.5 }}>Patch .claude/settings.json enable/allow lists</span>
            </label>

            <div
              style={{
                display: 'inline-block',
                border: '1px solid var(--ra-yellow)',
                color: 'var(--ra-yellow)',
                borderRadius: 999,
                padding: '3px 12px',
                fontSize: 11.5,
                marginBottom: 6
              }}
            >
              requires Codex CLI installed and authenticated on the server (see Install)
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <div style={{ flex: 1 }} />
              <button className='ra-btn' onClick={onClose}>
                Cancel
              </button>
              <button className='ra-btn primary' disabled={busy} onClick={() => void preview()}>
                {busy ? 'Previewing…' : 'Preview changes'}
              </button>
            </div>
          </>
        ) : (
          <>
            {diffs !== null && diffs.length > 0 ? (
              <>
                <p style={{ margin: '0 0 12px', color: 'var(--ra-text-dim)' }}>
                  The wizard will make the following changes:
                </p>
                {diffs.map((d) => (
                  <DiffCard key={d.path} diff={d} />
                ))}
              </>
            ) : (
              <p style={{ margin: '0 0 12px', color: 'var(--ra-text-dim)' }}>
                No changes needed — everything is already configured.
              </p>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <button className='ra-btn' disabled={busy} onClick={() => setStep('form')}>
                Back
              </button>
              <div style={{ flex: 1 }} />
              <button className='ra-btn' onClick={onClose}>
                Cancel
              </button>
              <button
                className='ra-btn primary'
                disabled={busy || diffs === null || diffs.length === 0}
                onClick={() => void apply()}
              >
                {busy ? 'Applying…' : 'Apply'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
