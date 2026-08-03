import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { TermExitReason } from '@shared/domain'
import { api } from '@/api'
import { useConnectionStore } from '@/stores/connection'

export interface XtermViewProps {
  hostId: string
  tmuxName?: string
  cwd?: string
  command?: string
  onExited?: (reason: TermExitReason) => void
}

/** Dark theme derived from theme/dark.css tokens. */
const XTERM_THEME = {
  background: '#10161f',
  foreground: '#dbe4f0',
  cursor: '#6ea8fe',
  selectionBackground: 'rgba(110,168,254,0.3)',
  black: '#1c2532',
  red: '#e5636e',
  green: '#3fb97f',
  yellow: '#d9a63f',
  blue: '#6ea8fe',
  magenta: '#b98af0',
  cyan: '#56c2d6',
  white: '#dbe4f0',
  brightBlack: '#5b6878',
  brightRed: '#f0808a',
  brightGreen: '#5fd69b',
  brightYellow: '#eec36a',
  brightBlue: '#8fbcff',
  brightMagenta: '#cfa9f7',
  brightCyan: '#7fd8e8',
  brightWhite: '#f2f6fb'
}

const EXIT_LABEL: Record<TermExitReason, string> = {
  detach: 'Terminal channel closed',
  error: 'Terminal error',
  'conn-lost': 'Connection to host lost',
  closed: 'Terminal closed'
}

interface ExitInfo {
  reason: TermExitReason
  message?: string
}

/**
 * One xterm.js terminal bound to a remote PTY channel (usually a
 * `tmux new-session -A` attach). Survives disconnects via the exit overlay +
 * auto-reattach when the host connection comes back.
 */
export default function XtermView({
  hostId,
  tmuxName,
  cwd,
  command,
  onExited
}: XtermViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termIdRef = useRef<string | null>(null)
  const openingRef = useRef(false)
  const [exit, setExit] = useState<ExitInfo | null>(null)
  const exitRef = useRef<ExitInfo | null>(null)
  exitRef.current = exit
  const onExitedRef = useRef(onExited)
  onExitedRef.current = onExited

  const openChannel = useCallback(async (): Promise<void> => {
    const term = termRef.current
    if (!term || openingRef.current || termIdRef.current !== null) return
    openingRef.current = true
    setExit(null)
    try {
      const el = containerRef.current
      if (el && el.clientWidth > 0 && el.clientHeight > 0) {
        try {
          fitRef.current?.fit()
        } catch {
          // fit is best-effort before the first layout pass
        }
      }
      const { termId } = await api.termOpen({
        hostId,
        tmuxName,
        cwd,
        command,
        cols: term.cols,
        rows: term.rows
      })
      if (!termRef.current) {
        // unmounted while opening — close the orphaned channel
        void api.termClose(termId).catch(() => undefined)
        return
      }
      termIdRef.current = termId
    } catch (err) {
      setExit({ reason: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      openingRef.current = false
    }
  }, [hostId, tmuxName, cwd, command])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    const mono =
      getComputedStyle(document.documentElement).getPropertyValue('--ra-mono').trim() || 'monospace'
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      scrollback: 1000,
      fontSize: 12.5,
      fontFamily: mono,
      allowProposedApi: true,
      theme: XTERM_THEME
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    termRef.current = term
    fitRef.current = fit
    term.open(el)

    let webgl: WebglAddon | null = null
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        addon.dispose()
        if (webgl === addon) webgl = null
      })
      term.loadAddon(addon)
      webgl = addon
    } catch {
      webgl = null // canvas/DOM renderer fallback
    }
    try {
      term.loadAddon(new Unicode11Addon())
      term.unicode.activeVersion = '11'
    } catch {
      // unicode width handling is cosmetic
    }
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      try {
        fit.fit()
      } catch {
        // ignore pre-layout fit failures
      }
    }

    const offData = api.onTermData((e) => {
      if (e.termId === termIdRef.current) term.write(e.data)
    })
    const offExit = api.onTermExit((e) => {
      if (e.termId !== termIdRef.current) return
      termIdRef.current = null
      const info: ExitInfo = { reason: e.reason, ...(e.message ? { message: e.message } : {}) }
      setExit(info)
      onExitedRef.current?.(e.reason)
    })
    const dataSub = term.onData((d) => {
      const id = termIdRef.current
      if (id) api.termWrite(id, new TextEncoder().encode(d))
    })

    let resizeTimer: number | null = null
    const ro = new ResizeObserver(() => {
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        resizeTimer = null
        if (!termRef.current || el.clientWidth === 0 || el.clientHeight === 0) return
        try {
          fit.fit()
        } catch {
          return
        }
        const id = termIdRef.current
        if (id) api.termResize(id, term.cols, term.rows)
      }, 100)
    })
    ro.observe(el)

    void openChannel()

    return () => {
      ro.disconnect()
      if (resizeTimer !== null) window.clearTimeout(resizeTimer)
      offData()
      offExit()
      dataSub.dispose()
      const id = termIdRef.current
      termIdRef.current = null
      // only close the channel when it has not already exited
      if (id) void api.termClose(id).catch(() => undefined)
      try {
        webgl?.dispose()
      } catch {
        // already disposed on context loss
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [openChannel])

  // auto-reattach after a lost connection comes back
  const connStatus = useConnectionStore((s) => s.statusByHost[hostId]?.status)
  useEffect(() => {
    if (connStatus === 'connected' && exitRef.current?.reason === 'conn-lost') {
      void openChannel()
    }
  }, [connStatus, openChannel])

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%', background: '#10161f' }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      {exit && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(13, 17, 23, 0.72)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 5
          }}
        >
          <div style={{ textAlign: 'center', maxWidth: 380, padding: 12 }}>
            <div style={{ color: 'var(--ra-text-dim)', marginBottom: 12, fontSize: 12.5 }}>
              {EXIT_LABEL[exit.reason]}
              {exit.message ? ` — ${exit.message}` : ''}
            </div>
            <button className='ra-btn primary' onClick={() => void openChannel()}>
              Reconnect
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
