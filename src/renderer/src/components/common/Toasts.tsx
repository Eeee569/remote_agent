import { useUiStore } from '@/stores/ui'
import type { ToastKind } from '@/stores/ui'

const KIND_COLOR: Record<ToastKind, string> = {
  info: 'var(--ra-accent)',
  error: 'var(--ra-red)',
  success: 'var(--ra-green)'
}

export default function Toasts(): React.JSX.Element {
  const toasts = useUiStore((s) => s.toasts)
  const dismissToast = useUiStore((s) => s.dismissToast)

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 2000,
        maxWidth: 420
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismissToast(t.id)}
          style={{
            background: 'var(--ra-bg-raised)',
            border: '1px solid var(--ra-border-strong)',
            borderLeft: `3px solid ${KIND_COLOR[t.kind]}`,
            borderRadius: 'var(--ra-radius)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
            padding: '9px 12px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            cursor: 'pointer',
            wordBreak: 'break-word'
          }}
        >
          <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>{t.text}</span>
          <span
            aria-label='Dismiss'
            style={{ color: 'var(--ra-text-faint)', lineHeight: 1, fontSize: 14 }}
          >
            &times;
          </span>
        </div>
      ))}
    </div>
  )
}
