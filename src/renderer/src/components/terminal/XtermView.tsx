import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import type { TermExitReason } from '@shared/domain'
import { api } from '@/api'
import ContextMenu from '@/components/common/ContextMenu'
import { terminalKeyAction } from '@/components/terminal/clipboard-keys'
import { isExternalFileDrag, pastedPathsText } from '@/components/terminal/file-paste'
import { parseOsc52 } from '@/components/terminal/osc52'
import { useConnectionStore } from '@/stores/connection'
import { useUiStore } from '@/stores/ui'
import { terminalBackground, xtermTheme } from '@/theme/tokens'

export interface XtermViewProps {
  hostId: string
  tmuxName?: string
  cwd?: string
  command?: string
  onExited?: (reason: TermExitReason) => void
}


const isMac = navigator.platform.startsWith('Mac')

/** a text paste is near-instant; only an upload lasts long enough to show */
const UPLOAD_BADGE_DELAY_MS = 250

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
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null)
  const exitRef = useRef<ExitInfo | null>(null)
  exitRef.current = exit
  const onExitedRef = useRef(onExited)
  onExitedRef.current = onExited

  /** Copy the terminal's own selection; false when there is nothing selected. */
  const copySelection = useCallback((): boolean => {
    const selection = termRef.current?.getSelection() ?? ''
    if (selection === '') return false
    api.clipboardWrite(selection)
    return true
  }, [])
  const copyRef = useRef(copySelection)
  copyRef.current = copySelection

  const addToast = useUiStore((s) => s.addToast)
  const [uploading, setUploading] = useState(false)
  const [dropActive, setDropActive] = useState(false)

  /** Runs a paste/upload, showing progress only when it is slow enough to notice. */
  const withUpload = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      const timer = window.setTimeout(() => setUploading(true), UPLOAD_BADGE_DELAY_MS)
      try {
        return await fn()
      } catch (err) {
        addToast('error', `Paste failed: ${err instanceof Error ? err.message : String(err)}`)
        return undefined
      } finally {
        window.clearTimeout(timer)
        setUploading(false)
      }
    },
    [addToast]
  )

  /** Uploaded files reach the agent as their host paths, as a local drag would. */
  const pastePaths = useCallback((paths: string[]): void => {
    const text = pastedPathsText(paths)
    if (text !== '') termRef.current?.paste(text)
    termRef.current?.focus()
  }, [])

  const pasteClipboard = useCallback((): void => {
    void withUpload(() => api.clipboardPaste(hostId)).then((res) => {
      // Terminal.paste honours bracketed-paste mode, so an agent CLI receives a
      // multi-line paste as one block instead of a submit per newline
      if (res?.kind === 'text') termRef.current?.paste(res.text)
      else if (res?.kind === 'files') pastePaths(res.paths)
    })
  }, [hostId, pastePaths, withUpload])
  const pasteRef = useRef(pasteClipboard)
  pasteRef.current = pasteClipboard

  const dropFiles = (files: File[]): void => {
    void withUpload(() => api.fsUploadFiles(hostId, files, null)).then((paths) => {
      if (paths) pastePaths(paths)
    })
  }

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
      // tmux runs with mouse mode on, so a plain drag is forwarded to tmux
      // rather than selecting; holding Option selects locally instead
      macOptionClickForcesSelection: true,
      theme: xtermTheme()
    })

    /*
     * xterm keeps its selection in its own model, not the DOM, so the
     * platform's Copy (which copies a DOM selection) finds nothing to take.
     * Wire the shortcuts to the terminal's own selection and to the OS
     * clipboard read in the main process instead.
     */
    term.attachCustomKeyEventHandler((e) => {
      const action = terminalKeyAction(e, { isMac, hasSelection: term.hasSelection() })
      if (action === 'pass') return true
      /*
       * Returning false only stops xterm from handling the key — the browser
       * still runs its own default for the shortcut. For ⌘V that default is a
       * second, native paste, which reaches an agent's prompt as duplicated
       * text; for ⌘C it would race our write with a copy of the empty helper
       * textarea.
       */
      e.preventDefault()
      if (action === 'copy') copyRef.current()
      if (action === 'paste') pasteRef.current()
      if (action === 'select-all') term.selectAll()
      return false
    })

    /*
     * The only route from the host's clipboard to this Mac's: tmux copy-mode,
     * an editor's oscyank, or an agent CLI's "copy" all emit OSC 52, which
     * xterm.js does not implement. Writes only — parseOsc52 refuses the read
     * request that would send the local clipboard back to the server.
     */
    term.parser.registerOscHandler(52, (payload) => {
      const text = parseOsc52(payload)
      if (text !== null) api.clipboardWrite(text)
      return true // consumed either way, so a rejected payload is never printed
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
    <div
      style={{ position: 'relative', height: '100%', width: '100%', background: terminalBackground() }}
      onDragOver={(e) => {
        if (!isExternalFileDrag(Array.from(e.dataTransfer.types))) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (!dropActive) setDropActive(true)
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false)
      }}
      onDrop={(e) => {
        setDropActive(false)
        const files = Array.from(e.dataTransfer.files)
        if (files.length === 0) return
        e.preventDefault()
        dropFiles(files)
      }}
    >
      <div
        ref={containerRef}
        style={{ position: 'absolute', inset: 0 }}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({
            x: e.clientX,
            y: e.clientY,
            hasSelection: (termRef.current?.getSelection() ?? '') !== ''
          })
        }}
      />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          width={190}
          entries={[
            {
              kind: 'item',
              icon: '⧉',
              label: `Copy${isMac ? '  ⌘C' : '  Ctrl+Shift+C'}`,
              disabled: !menu.hasSelection,
              title: menu.hasSelection
                ? 'Copy the selected text'
                : 'Nothing selected — hold ⌥ while dragging to select (tmux owns the mouse)',
              onClick: () => {
                copySelection()
                setMenu(null)
              }
            },
            {
              kind: 'item',
              icon: '⇥',
              label: `Paste${isMac ? '  ⌘V' : '  Ctrl+Shift+V'}`,
              title: 'Send the clipboard to the terminal',
              onClick: () => {
                pasteClipboard()
                setMenu(null)
              }
            },
            { kind: 'separator' },
            {
              kind: 'item',
              icon: '▤',
              label: 'Select all',
              onClick: () => {
                termRef.current?.selectAll()
                setMenu(null)
              }
            },
            {
              kind: 'item',
              icon: '✕',
              label: 'Clear selection',
              disabled: !menu.hasSelection,
              onClick: () => {
                termRef.current?.clearSelection()
                setMenu(null)
              }
            }
          ]}
          onDismiss={() => setMenu(null)}
        />
      )}
      {dropActive && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 6,
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '2px dashed var(--ra-accent)',
            background: 'var(--ra-accent-dim)',
            color: 'var(--ra-text)',
            fontSize: 12.5
          }}
        >
          Drop to upload and paste the path
        </div>
      )}
      {uploading && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 12,
            zIndex: 6,
            pointerEvents: 'none',
            padding: '3px 9px',
            borderRadius: 4,
            fontSize: 11.5,
            background: 'var(--ra-bg-raised)',
            border: '1px solid var(--ra-border-strong)',
            color: 'var(--ra-text-dim)'
          }}
        >
          Uploading…
        </div>
      )}
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
