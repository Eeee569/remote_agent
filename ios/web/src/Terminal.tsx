import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { parseOsc52 } from '@/components/terminal/osc52'
import { xtermTheme } from '@/theme/tokens'
import { base64ToBytes, bytesToBase64, call, clipboardRead, clipboardWrite, on, post } from './native'
import { buildAttachCommand } from './remote'

// ---------- routing of terminal output to the view that owns the channel ----------

const sinks = new Map<string, (bytes: Uint8Array) => void>()
const exitSinks = new Map<string, (reason: string, message?: string) => void>()
/**
 * Output can be pushed before `term.open` has answered with the channel's id.
 * Hold it briefly instead of dropping the first screen tmux draws.
 */
const early = new Map<string, Uint8Array[]>()

on('term.data', (payload) => {
  const termId = payload.termId as string
  const bytes = base64ToBytes(payload.data as string)
  const sink = sinks.get(termId)
  if (sink) {
    sink(bytes)
    return
  }
  const held = early.get(termId) ?? []
  if (held.length < 400) held.push(bytes)
  early.set(termId, held)
  if (early.size > 8) early.delete(early.keys().next().value as string)
})

on('term.exit', (payload) => {
  const termId = payload.termId as string
  early.delete(termId)
  exitSinks.get(termId)?.(payload.reason as string, payload.message as string | undefined)
})

// ---------- component ----------

export interface TerminalHandle {
  /** Send raw input, as if typed. */
  send(data: string): void
  /** Cursor key, honouring the application-cursor mode the program asked for. */
  arrow(direction: 'A' | 'B' | 'C' | 'D'): void
  paste(): void
  focus(): void
  blur(): void
  /** Arm Ctrl for the next typed character. */
  setCtrl(armed: boolean): void
}

interface TerminalViewProps {
  /** connection to attach over; null while the host is being (re)connected */
  connId: string | null
  tmuxName: string
  cwd: string
  fontSize: number
  visible: boolean
  onCtrlUsed: () => void
}

const encoder = new TextEncoder()

const TerminalView = forwardRef<TerminalHandle, TerminalViewProps>(function TerminalView(
  { connId, tmuxName, cwd, fontSize, visible, onCtrlUsed },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termIdRef = useRef<string | null>(null)
  const ctrlRef = useRef(false)
  const onCtrlUsedRef = useRef(onCtrlUsed)
  onCtrlUsedRef.current = onCtrlUsed
  const [ended, setEnded] = useState<string | null>(null)
  const [attachNonce, setAttachNonce] = useState(0)

  const write = (data: string): void => {
    const id = termIdRef.current
    if (id) post('term.write', { termId: id, data: bytesToBase64(encoder.encode(data)) })
  }
  const writeRef = useRef(write)
  writeRef.current = write

  /** Fit xterm to its box and tell the PTY when that changed the grid. */
  const fitAndSync = (): void => {
    const el = containerRef.current
    const term = termRef.current
    if (!el || !term || el.clientWidth === 0 || el.clientHeight === 0) return
    const before = { cols: term.cols, rows: term.rows }
    try {
      fitRef.current?.fit()
    } catch {
      return
    }
    const id = termIdRef.current
    if (id && (term.cols !== before.cols || term.rows !== before.rows)) {
      post('term.resize', { termId: id, cols: term.cols, rows: term.rows })
    }
  }
  const fitRefFn = useRef(fitAndSync)
  fitRefFn.current = fitAndSync

  useImperativeHandle(ref, () => ({
    send: (data) => writeRef.current(data),
    arrow: (direction) => {
      const app = termRef.current?.modes.applicationCursorKeysMode ?? false
      writeRef.current((app ? '\x1bO' : '\x1b[') + direction)
    },
    paste: () => {
      void clipboardRead().then((text) => {
        if (text !== '') termRef.current?.paste(text)
      })
    },
    focus: () => termRef.current?.focus(),
    blur: () => termRef.current?.blur(),
    setCtrl: (armed) => {
      ctrlRef.current = armed
    }
  }))

  // the xterm instance lives as long as the view
  useEffect(() => {
    const el = containerRef.current
    if (!el) return undefined
    const term = new Terminal({
      cursorBlink: true,
      scrollback: 2000,
      fontSize,
      fontFamily: 'ui-monospace, Menlo, "SF Mono", Consolas, monospace',
      allowProposedApi: true,
      theme: xtermTheme()
    })
    term.parser.registerOscHandler(52, (payload) => {
      const text = parseOsc52(payload)
      if (text !== null) clipboardWrite(text)
      return true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      // DOM renderer fallback
    }
    try {
      term.loadAddon(new Unicode11Addon())
      term.unicode.activeVersion = '11'
    } catch {
      // cosmetic
    }
    termRef.current = term
    fitRef.current = fit

    const dataSub = term.onData((d) => {
      if (ctrlRef.current && d.length === 1) {
        const code = d.toUpperCase().charCodeAt(0)
        if (code >= 0x40 && code <= 0x5f) {
          ctrlRef.current = false
          onCtrlUsedRef.current()
          writeRef.current(String.fromCharCode(code & 0x1f))
          return
        }
      }
      writeRef.current(d)
    })

    let timer: number | null = null
    const ro = new ResizeObserver(() => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        timer = null
        fitRefFn.current()
      }, 60)
    })
    ro.observe(el)

    /*
     * tmux owns the screen (alternate buffer, mouse mode on), so xterm has no
     * scrollback of its own to pan. A finger drag is translated into the wheel
     * events tmux expects, which scrolls its history; with no mouse mode the
     * drag scrolls xterm's own buffer.
     */
    let lastY: number | null = null
    let carry = 0
    let moved = false
    const cellHeight = (): number => Math.max(el.clientHeight / Math.max(term.rows, 1), 8)
    /**
     * Programs move several lines per wheel notch (tmux: 5, less/vim: 3), so one
     * notch per line of finger travel would fly. One per three lines tracks the
     * finger closely without feeling sluggish.
     */
    const LINES_PER_NOTCH = 3
    const onTouchStart = (e: TouchEvent): void => {
      lastY = e.touches.length === 1 ? e.touches[0].clientY : null
      carry = 0
      moved = false
    }
    const onTouchMove = (e: TouchEvent): void => {
      if (lastY === null || e.touches.length !== 1) return
      const y = e.touches[0].clientY
      carry += y - lastY
      lastY = y
      const tracking = term.modes.mouseTrackingMode !== 'none'
      const step = cellHeight() * (tracking ? LINES_PER_NOTCH : 1)
      const lines = Math.trunc(carry / step)
      if (lines === 0) {
        if (moved) e.preventDefault()
        return
      }
      moved = true
      carry -= lines * step
      e.preventDefault()
      e.stopPropagation()
      if (!tracking) {
        term.scrollLines(-lines)
        return
      }
      const rect = el.getBoundingClientRect()
      const col = Math.min(term.cols, Math.max(1, Math.ceil(((e.touches[0].clientX - rect.left) / rect.width) * term.cols)))
      const row = Math.min(term.rows, Math.max(1, Math.ceil(((y - rect.top) / rect.height) * term.rows)))
      // SGR mouse report: button 64 = wheel up, 65 = wheel down
      const report = `\x1b[<${lines > 0 ? 64 : 65};${col};${row}M`
      writeRef.current(report.repeat(Math.min(Math.abs(lines), 20)))
    }
    el.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
    el.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })
    // a tap brings up the keyboard
    const onClick = (): void => term.focus()
    el.addEventListener('click', onClick)

    return () => {
      ro.disconnect()
      if (timer !== null) window.clearTimeout(timer)
      el.removeEventListener('touchstart', onTouchStart, { capture: true })
      el.removeEventListener('touchmove', onTouchMove, { capture: true })
      el.removeEventListener('click', onClick)
      dataSub.dispose()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // the font size is applied by its own effect below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    fitRefFn.current()
  }, [fontSize])

  // a hidden terminal has no box to fit; catch up when it is shown again
  useEffect(() => {
    if (visible) fitRefFn.current()
  }, [visible])

  // one PTY channel per (connection, session); re-attached after a reconnect
  useEffect(() => {
    const term = termRef.current
    if (!term || connId === null) return undefined
    let cancelled = false
    let opened: string | null = null
    setEnded(null)
    fitRefFn.current()
    const sent = { cols: term.cols, rows: term.rows }

    call<{ termId: string }>('term.open', {
      connId,
      cols: sent.cols,
      rows: sent.rows,
      command: buildAttachCommand(tmuxName, cwd)
    })
      .then(({ termId }) => {
        if (cancelled) {
          void call('term.close', { termId }).catch(() => undefined)
          return
        }
        opened = termId
        termIdRef.current = termId
        term.reset()
        sinks.set(termId, (bytes) => term.write(bytes))
        exitSinks.set(termId, (reason, message) => {
          if (termIdRef.current === termId) termIdRef.current = null
          sinks.delete(termId)
          exitSinks.delete(termId)
          // a lost connection is handled by the reconnect, which re-attaches
          if (reason !== 'conn-lost' && reason !== 'closed') {
            setEnded(message ?? 'The terminal channel closed.')
          }
        })
        for (const bytes of early.get(termId) ?? []) term.write(bytes)
        early.delete(termId)
        // the box may have changed while the channel was opening
        fitRefFn.current()
        if (term.cols !== sent.cols || term.rows !== sent.rows) {
          post('term.resize', { termId, cols: term.cols, rows: term.rows })
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setEnded(err instanceof Error ? err.message : String(err))
      })

    return () => {
      cancelled = true
      if (opened !== null) {
        sinks.delete(opened)
        exitSinks.delete(opened)
        if (termIdRef.current === opened) termIdRef.current = null
        void call('term.close', { termId: opened }).catch(() => undefined)
      }
    }
  }, [connId, tmuxName, cwd, attachNonce])

  return (
    <div className='term-wrap' style={{ display: visible ? 'block' : 'none' }}>
      <div ref={containerRef} className='term-box' />
      {connId === null && <div className='term-overlay'>Reconnecting…</div>}
      {connId !== null && ended !== null && (
        <div className='term-overlay'>
          <div>{ended}</div>
          <button className='btn primary' onClick={() => setAttachNonce((n) => n + 1)}>
            Reattach
          </button>
        </div>
      )}
    </div>
  )
})

export default TerminalView
