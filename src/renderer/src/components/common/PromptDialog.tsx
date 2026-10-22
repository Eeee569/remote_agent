import { useEffect, useRef, useState } from 'react'

export interface PromptDialogProps {
  title: string
  /** short hint above the field, e.g. the directory being created in */
  label: string
  initialValue: string
  confirmLabel: string
  placeholder?: string
  /** select the first `selectTo` characters on open (file stem, say) */
  selectTo?: number
  /** message to show instead of submitting; null when the value is fine */
  validate?(value: string): string | null
  onSubmit(value: string): void
  onCancel(): void
}

/**
 * Single-field modal prompt. Electron's renderer has no `window.prompt`
 * (it throws), so every "type a name" flow goes through this.
 */
export default function PromptDialog(props: PromptDialogProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [value, setValue] = useState(props.initialValue)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    const end = props.selectTo !== undefined ? props.selectTo : props.initialValue.length
    el.setSelectionRange(0, Math.min(end, props.initialValue.length))
    // mount-only: the dialog is remounted per prompt (keyed by the caller)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const submit = (): void => {
    const message = props.validate?.(value) ?? null
    if (message !== null) {
      setError(message)
      inputRef.current?.focus()
      return
    }
    props.onSubmit(value)
  }

  return (
    <div
      className='ra-dialog-backdrop'
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onCancel()
      }}
    >
      <div
        className='ra-dialog'
        style={{ width: 460, minWidth: 0 }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            submit()
          } else if (e.key === 'Escape') {
            e.preventDefault()
            props.onCancel()
          }
        }}
      >
        <h2>{props.title}</h2>
        {/* not .ra-label: it uppercases, and these labels carry real paths */}
        <div
          style={{
            fontSize: 12,
            color: 'var(--ra-text-dim)',
            marginBottom: 6,
            wordBreak: 'break-all'
          }}
        >
          {props.label}
        </div>
        <input
          ref={inputRef}
          className='ra-input'
          style={{ width: '100%', fontFamily: 'var(--ra-mono)', fontSize: 12.5 }}
          value={value}
          placeholder={props.placeholder}
          spellCheck={false}
          onChange={(e) => {
            setValue(e.target.value)
            if (error !== null) setError(null)
          }}
        />
        {error !== null && (
          <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ra-red)' }}>{error}</div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className='ra-btn' onClick={props.onCancel}>
            Cancel
          </button>
          <button className='ra-btn primary' onClick={submit}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
