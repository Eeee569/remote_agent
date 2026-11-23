/** Small shared pieces: bottom sheet, confirm dialog, focus-preserving buttons. */
import { useEffect, useRef } from 'react'
import { create } from 'zustand'

// ---------- confirm ----------

interface ConfirmRequest {
  title: string
  message?: string
  okLabel: string
  danger?: boolean
  /** an extra opt-in the caller reads back (e.g. "also remove the worktree") */
  checkbox?: string
  resolve: (result: { ok: boolean; checked: boolean }) => void
}

const useConfirm = create<{ request: ConfirmRequest | null; checked: boolean }>(() => ({
  request: null,
  checked: false
}))

/** In-page confirm: WKWebView shows no native `window.confirm` on its own. */
export function confirmAsk(
  opts: Omit<ConfirmRequest, 'resolve'>
): Promise<{ ok: boolean; checked: boolean }> {
  return new Promise((resolve) => {
    useConfirm.setState({ request: { ...opts, resolve }, checked: false })
  })
}

export function ConfirmHost(): React.JSX.Element | null {
  const { request, checked } = useConfirm()
  if (!request) return null
  const finish = (ok: boolean): void => {
    useConfirm.setState({ request: null })
    request.resolve({ ok, checked })
  }
  return (
    <div className='modal-backdrop' onClick={() => finish(false)}>
      <div className='dialog' onClick={(e) => e.stopPropagation()}>
        <div className='dialog-title'>{request.title}</div>
        {request.message && <div className='dialog-message'>{request.message}</div>}
        {request.checkbox && (
          <label className='check'>
            <input
              type='checkbox'
              checked={checked}
              onChange={(e) => useConfirm.setState({ checked: e.target.checked })}
            />
            {request.checkbox}
          </label>
        )}
        <div className='dialog-actions'>
          <button className='btn' onClick={() => finish(false)}>
            Cancel
          </button>
          <button className={`btn ${request.danger ? 'danger' : 'primary'}`} onClick={() => finish(true)}>
            {request.okLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------- sheet ----------

export function Sheet({
  title,
  onClose,
  children
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className='modal-backdrop sheet-backdrop' onClick={onClose}>
      <div className='sheet' onClick={(e) => e.stopPropagation()}>
        <div className='sheet-head'>
          <div className='sheet-title'>{title}</div>
          <button className='btn ghost' onClick={onClose}>
            Close
          </button>
        </div>
        <div className='sheet-body'>{children}</div>
      </div>
    </div>
  )
}

// ---------- key bar button ----------

/**
 * A button that does not take focus when pressed. The on-screen keyboard is
 * up only while the terminal's input has focus, so an ordinary button in the
 * key bar would dismiss it on every tap.
 */
export function KeyButton({
  label,
  onPress,
  active,
  wide,
  title,
  className
}: {
  label: string
  onPress: () => void
  active?: boolean
  wide?: boolean
  title?: string
  className?: string
}): React.JSX.Element {
  const ref = useRef<HTMLButtonElement | null>(null)
  const pressRef = useRef(onPress)
  pressRef.current = onPress

  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    let startX = 0
    let startY = 0
    let touching = false
    const touchStart = (e: TouchEvent): void => {
      touching = true
      startX = e.touches[0].clientX
      startY = e.touches[0].clientY
    }
    const touchEnd = (e: TouchEvent): void => {
      if (!touching) return
      touching = false
      // preventing the default here stops both the focus change and the
      // synthesized click, while leaving the bar free to scroll sideways
      e.preventDefault()
      const t = e.changedTouches[0]
      if (Math.abs(t.clientX - startX) < 12 && Math.abs(t.clientY - startY) < 12) pressRef.current()
    }
    const mouseDown = (e: MouseEvent): void => e.preventDefault()
    const click = (): void => pressRef.current()
    el.addEventListener('touchstart', touchStart, { passive: true })
    el.addEventListener('touchend', touchEnd, { passive: false })
    el.addEventListener('mousedown', mouseDown)
    el.addEventListener('click', click)
    return () => {
      el.removeEventListener('touchstart', touchStart)
      el.removeEventListener('touchend', touchEnd)
      el.removeEventListener('mousedown', mouseDown)
      el.removeEventListener('click', click)
    }
  }, [])

  return (
    <button
      ref={ref}
      type='button'
      tabIndex={-1}
      title={title}
      className={`key${active ? ' active' : ''}${wide ? ' wide' : ''}${className ? ' ' + className : ''}`}
    >
      {label}
    </button>
  )
}
