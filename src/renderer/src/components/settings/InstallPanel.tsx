/**
 * Remote tooling status + installer for a host: probes python3/tmux/git and
 * the helper/claude/codex installs, streams install logs, and offers
 * one-click install/update for the installable targets.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { IDockviewPanelProps } from 'dockview'
import type { BootstrapStatus, InstallTarget, ToolStatus } from '@shared/domain'
import { api } from '@/api'
import { useConnectionStore } from '@/stores/connection'
import { useUiStore } from '@/stores/ui'
import { errText } from './settings-util'

interface RowSpec {
  key: keyof BootstrapStatus
  label: string
  installable?: InstallTarget
  authHint?: string
}

const ROWS: readonly RowSpec[] = [
  { key: 'python3', label: 'python3' },
  { key: 'tmux', label: 'tmux' },
  { key: 'git', label: 'git' },
  { key: 'helper', label: 'helper', installable: 'helper' },
  {
    key: 'claude',
    label: 'Claude Code',
    installable: 'claude',
    authHint: 'run claude inside a session to sign in'
  },
  {
    key: 'codex',
    label: 'Codex CLI',
    installable: 'codex',
    authHint: 'run codex login inside a session, or set OPENAI_API_KEY in Claude settings env'
  }
]

function chipText(key: keyof BootstrapStatus, st: ToolStatus): { text: string; color: string } {
  if (!st.present) return { text: 'missing', color: 'var(--ra-red)' }
  if (key === 'helper' && st.upToDate === false) return { text: 'outdated', color: 'var(--ra-yellow)' }
  const v = st.version ?? ''
  const text = v === '' ? 'installed' : /^\d/.test(v) ? `v${v}` : v
  return { text, color: 'var(--ra-green)' }
}

export function InstallPanelContent({ hostId }: { hostId: string }): React.JSX.Element {
  const connStatus = useConnectionStore((s) => s.statusByHost[hostId]?.status ?? 'idle')
  const connected = connStatus === 'connected'
  const [status, setStatus] = useState<BootstrapStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<InstallTarget | null>(null)
  const [log, setLog] = useState<string[]>([])
  const logRef = useRef<HTMLDivElement | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setChecking(true)
    setCheckError(null)
    try {
      setStatus(await api.bootstrapStatus(hostId))
    } catch (err) {
      const msg = errText(err)
      setCheckError(msg)
      useUiStore.getState().addToast('error', `Tool check failed: ${msg}`)
    } finally {
      setChecking(false)
    }
  }, [hostId])

  useEffect(() => {
    if (connected) void refresh()
  }, [connected, refresh])

  useEffect(
    () =>
      api.onBootstrapProgress((e) => {
        if (e.hostId !== hostId) return
        setLog((l) => {
          const next = [...l, `[${e.target}] ${e.line}`]
          return next.length > 500 ? next.slice(next.length - 500) : next
        })
      }),
    [hostId]
  )

  useEffect(() => {
    const el = logRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [log])

  const install = async (target: InstallTarget): Promise<void> => {
    setInstalling(target)
    try {
      const res = await api.bootstrapInstall(hostId, [target])
      if (!res.ok) {
        useUiStore.getState().addToast('error', `Install of ${target} did not complete — see log`)
      }
      await refresh()
    } catch (err) {
      useUiStore.getState().addToast('error', `Install of ${target} failed: ${errText(err)}`)
    } finally {
      setInstalling(null)
    }
  }

  if (!connected) {
    return (
      <div style={{ color: 'var(--ra-text-faint)', padding: '24px 0', textAlign: 'center' }}>
        Connect to this host first to check and install tools.
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 680 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 12.5, color: 'var(--ra-text-dim)' }}>
          Remote tooling status
        </span>
        <div style={{ flex: 1 }} />
        <button className='ra-btn' disabled={checking} onClick={() => void refresh()}>
          {checking ? 'Checking…' : 'Re-check'}
        </button>
      </div>

      {checkError !== null && (
        <div style={{ color: 'var(--ra-red)', fontSize: 12, marginBottom: 10 }}>{checkError}</div>
      )}

      {status === null && checkError === null && (
        <div style={{ color: 'var(--ra-text-faint)', marginBottom: 10 }}>
          {checking ? 'Probing remote tools…' : 'No status yet.'}
        </div>
      )}

      {status !== null && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '130px 1fr auto',
            alignItems: 'center',
            rowGap: 2,
            border: '1px solid var(--ra-border)',
            borderRadius: 8,
            background: 'var(--ra-bg-raised)',
            padding: '8px 12px',
            marginBottom: 14
          }}
        >
          {ROWS.map((row) => {
            const st = status[row.key]
            const chip = chipText(row.key, st)
            const needsInstall =
              row.installable !== undefined &&
              (!st.present || (row.key === 'helper' && st.upToDate === false))
            return (
              <div key={row.key} style={{ display: 'contents' }}>
                <div style={{ padding: '7px 0', fontWeight: 600, fontSize: 12.5 }}>{row.label}</div>
                <div style={{ padding: '7px 0', minWidth: 0 }}>
                  <span
                    style={{
                      fontFamily: 'var(--ra-mono)',
                      fontSize: 11,
                      color: chip.color,
                      border: `1px solid ${chip.color}`,
                      borderRadius: 999,
                      padding: '1px 8px',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {chip.text}
                  </span>
                  {row.authHint !== undefined && st.present && (
                    <div style={{ fontSize: 11, color: 'var(--ra-text-faint)', marginTop: 4 }}>
                      {row.authHint}
                    </div>
                  )}
                </div>
                <div style={{ padding: '7px 0', textAlign: 'right' }}>
                  {row.installable !== undefined && (
                    <button
                      className={needsInstall ? 'ra-btn primary' : 'ra-btn'}
                      disabled={installing !== null || checking}
                      onClick={() => void install(row.installable as InstallTarget)}
                    >
                      {installing === row.installable
                        ? 'Working…'
                        : st.present
                          ? 'Update'
                          : 'Install'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <label className='ra-label'>Install log</label>
      <div
        ref={logRef}
        style={{
          background: 'var(--ra-bg)',
          border: '1px solid var(--ra-border)',
          borderRadius: 'var(--ra-radius)',
          padding: '8px 10px',
          fontFamily: 'var(--ra-mono)',
          fontSize: 11.5,
          lineHeight: 1.5,
          maxHeight: 260,
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        }}
      >
        {log.length === 0 ? (
          <span style={{ color: 'var(--ra-text-faint)' }}>Install output will appear here.</span>
        ) : (
          log.map((line, i) => <div key={i}>{line}</div>)
        )}
      </div>
    </div>
  )
}

const InstallPanel: React.FC<IDockviewPanelProps<{ hostId: string }>> = (props) => {
  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 20 }}>
      <h3 style={{ margin: '0 0 2px', fontSize: 14 }}>Install / tools</h3>
      <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--ra-text-dim)' }}>
        Remote tooling for this host
      </p>
      <InstallPanelContent hostId={props.params.hostId} />
    </div>
  )
}

export default InstallPanel
