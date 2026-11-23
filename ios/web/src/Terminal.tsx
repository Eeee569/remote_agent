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
  /**
   * Hand over text written in the compose box: pasted in one piece, then
   * Enter. Empty text is just Enter.
   */
  submit(text: string): void
  /** Scroll the history one screen: -1 is back (older), 1 is forward. */
  page(direction: -1 | 1): void
}

interface TerminalViewProps {
  /** connection to attach over; null while the host is being (re)connected */
  connId: string | null
  tmuxName: string
  cwd: string
  fontSize: number
  visible: boolean
  /**
   * true: the on-screen keyboard types straight into the terminal.
   * false: input comes from the compose box, and touching the terminal never
   * raises the keyboard.
   */
  direct: boolean
  onCtrlUsed: () => void
}

const encoder = new TextEncoder()

const TerminalView = forwardRef<TerminalHandle, TerminalViewProps>(function TerminalView(
  { connId, tmuxName, cwd, fontSize, visible, direct, onCtrlUsed },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const termIdRef = useRef<string | null>(null)
  const ctrlRef = useRef(false)
  const scrollRef = useRef<(lines: number, x?: number, y?: number) => void>(() => undefined)
  const directRef = useRef(direct)
  directRef.current = direct
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
    },
    submit: (text) => {
      const term = termRef.current
      if (!term) return
      if (text === '') {
        writeRef.current('\r')
        return
      }
      // xterm wraps this in a bracketed paste when the program asked for one,
      // so line breaks inside the text do not submit it early
      term.paste(text)
      // a program reading a paste treats an Enter glued to its end as part of it
      window.setTimeout(() => writeRef.current('\r'), 80)
    },
    page: (direction) => {
      const rows = termRef.current?.rows ?? 24
      scrollRef.current(-direction * Math.max(rows - 2, 1))
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
    const cellHeight = (): number => Math.max(el.clientHeight / Math.max(term.rows, 1), 8)
    /** Lines one wheel notch moves in the programs this is used with (tmux: 5). */
    const LINES_PER_NOTCH = 5
    let notchDebt = 0
    /**
     * Scroll the history by `lines` (positive: towards older output). x/y say
     * where on the terminal the finger is, for the mouse report.
     */
    const scrollBy = (lines: number, x?: number, y?: number): void => {
      if (term.modes.mouseTrackingMode === 'none') {
        notchDebt += lines
        const whole = Math.trunc(notchDebt)
        notchDebt -= whole
        if (whole !== 0) term.scrollLines(-whole)
        return
      }
      notchDebt += lines / LINES_PER_NOTCH
      const notches = Math.trunc(notchDebt)
      if (notches === 0) return
      notchDebt -= notches
      const rect = el.getBoundingClientRect()
      const fx = x === undefined ? 0.5 : (x - rect.left) / rect.width
      const fy = y === undefined ? 0.5 : (y - rect.top) / rect.height
      const col = Math.min(term.cols, Math.max(1, Math.ceil(fx * term.cols)))
      const row = Math.min(term.rows, Math.max(1, Math.ceil(fy * term.rows)))
      // SGR mouse report: button 64 = wheel up, 65 = wheel down
      const report = `\x1b[<${notches > 0 ? 64 : 65};${col};${row}M`
      writeRef.current(report.repeat(Math.min(Math.abs(notches), 60)))
    }
    scrollRef.current = scrollBy

    /*
     * Finger tracking, then a glide after the finger lifts — as a native list
     * scrolls. A slow drag moves the text with the finger; the faster the
     * flick, the further each pixel of glide carries, so a long history is a
     * few flicks away rather than hundreds of drags.
     */
    let lastX = 0
    let lastY: number | null = null
    let lastT = 0
    let velocity = 0 // px per ms, smoothed
    let moved = false
    let glide: number | null = null
    const stopGlide = (): void => {
      if (glide !== null) cancelAnimationFrame(glide)
      glide = null
    }
    /*
     * Touch events keep going to the element the finger landed on, and stop
     * reaching its ancestors if it is removed from the page — which is what
     * happens when the screen redraws mid-swipe and xterm replaces the row
     * under the finger. So the rest of the gesture is also listened for on
     * that element itself; `seen` keeps an event from being handled twice
     * while the element is still in place.
     */
    const seen = new WeakSet<Event>()
    let grip: EventTarget | null = null
    const release = (): void => {
      grip?.removeEventListener('touchmove', onTouchMove as EventListener)
      grip?.removeEventListener('touchend', onTouchEnd as EventListener)
      grip?.removeEventListener('touchcancel', onTouchEnd as EventListener)
      grip = null
    }
    const onTouchStart = (e: TouchEvent): void => {
      release()
      grip = e.target
      grip?.addEventListener('touchmove', onTouchMove as EventListener, { passive: false })
      grip?.addEventListener('touchend', onTouchEnd as EventListener, { passive: true })
      grip?.addEventListener('touchcancel', onTouchEnd as EventListener, { passive: true })
      stopGlide()
      notchDebt = 0
      velocity = 0
      moved = false
      if (e.touches.length !== 1) {
        lastY = null
        return
      }
      lastX = e.touches[0].clientX
      lastY = e.touches[0].clientY
      lastT = e.timeStamp
    }
    const onTouchMove = (e: TouchEvent): void => {
      if (seen.has(e)) return
      seen.add(e)
      if (lastY === null || e.touches.length !== 1) return
      const y = e.touches[0].clientY
      const dy = y - lastY
      const dt = Math.max(e.timeStamp - lastT, 1)
      // a few px of slop so a tap is not a scroll
      if (!moved && Math.abs(dy) < 6) return
      moved = true
      lastX = e.touches[0].clientX
      lastY = y
      lastT = e.timeStamp
      velocity = 0.7 * velocity + 0.3 * (dy / dt)
      e.preventDefault()
      e.stopPropagation()
      // speed up with the finger: 1x when reading, up to 4x when swiping hard
      const gain = 1 + Math.min(Math.abs(velocity) * 1.5, 3)
      scrollBy((dy / cellHeight()) * gain, lastX, y)
    }
    const onTouchEnd = (e: TouchEvent): void => {
      if (seen.has(e)) return
      seen.add(e)
      if (e.touches.length === 0) release()
      if (lastY === null || e.touches.length > 0) return
      const endY = lastY
      lastY = null
      // a finger that rested before lifting is not a flick
      if (!moved || e.timeStamp - lastT > 80 || Math.abs(velocity) < 0.25) return
      let v = velocity
      const gain = 1 + Math.min(Math.abs(v) * 4, 14)
      let prev = performance.now()
      const step = (now: number): void => {
        const dt = Math.min(now - prev, 50)
        prev = now
        scrollBy(((v * dt) / cellHeight()) * gain, lastX, endY)
        v *= Math.pow(0.997, dt)
        glide = Math.abs(v) > 0.03 ? requestAnimationFrame(step) : null
      }
      glide = requestAnimationFrame(step)
    }
    el.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
    el.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })
    el.addEventListener('touchend', onTouchEnd, { capture: true, passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true })
    // in direct mode a tap brings up the keyboard
    const onClick = (): void => {
      if (directRef.current) term.focus()
    }
    el.addEventListener('click', onClick)

    return () => {
      ro.disconnect()
      if (timer !== null) window.clearTimeout(timer)
      el.removeEventListener('touchstart', onTouchStart, { capture: true })
      el.removeEventListener('touchmove', onTouchMove, { capture: true })
      el.removeEventListener('touchend', onTouchEnd, { capture: true })
      el.removeEventListener('touchcancel', onTouchEnd, { capture: true })
      release()
      stopGlide()
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

  /*
   * With the compose box in charge, xterm's hidden input must not raise the
   * keyboard when the terminal is touched (xterm focuses it on every tap).
   */
  useEffect(() => {
    const input = termRef.current?.textarea
    if (!input) return
    input.inputMode = direct ? 'text' : 'none'
    if (!direct && document.activeElement === input) input.blur()
  }, [direct])

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
