import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '@/api'
import { PDF_READ_CAP_BYTES, hasPdfHeader } from '@/components/files/pdf'

interface PdfFileViewProps {
  hostId: string
  path: string
}

type State =
  | { phase: 'loading' }
  | { phase: 'ready'; url: string; mtimeMs: number }
  | { phase: 'error'; message: string }

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : `${Math.max(1, Math.round(bytes / 1024))} KiB`
}

const centerStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--ra-text-dim)',
  fontSize: 12.5,
  padding: 16,
  textAlign: 'center'
}

/**
 * Read-only PDF tab: the file is read whole over SFTP and handed to
 * Chromium's built-in viewer as a blob URL, which brings paging, zoom,
 * search, and print with it.
 */
export default function PdfFileView({ hostId, path }: PdfFileViewProps): React.JSX.Element {
  const [state, setState] = useState<State>({ phase: 'loading' })
  const urlRef = useRef<string | null>(null)
  const loadSeq = useRef(0)

  const releaseUrl = (): void => {
    if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current)
    urlRef.current = null
  }

  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current
    setState({ phase: 'loading' })
    try {
      const res = await api.fsRead(hostId, path, PDF_READ_CAP_BYTES)
      if (seq !== loadSeq.current) return
      if (res.truncated) {
        setState({
          phase: 'error',
          message: `This PDF is ${formatSize(res.size)} — larger than the ${formatSize(PDF_READ_CAP_BYTES)} the viewer loads.`
        })
        return
      }
      if (!hasPdfHeader(res.data)) {
        setState({ phase: 'error', message: 'This file has a .pdf name but is not a PDF.' })
        return
      }
      releaseUrl()
      const url = URL.createObjectURL(
        new Blob([res.data as Uint8Array<ArrayBuffer>], { type: 'application/pdf' })
      )
      urlRef.current = url
      setState({ phase: 'ready', url, mtimeMs: res.mtimeMs })
    } catch (err) {
      if (seq === loadSeq.current) setState({ phase: 'error', message: errText(err) })
    }
  }, [hostId, path])

  useEffect(() => {
    void load()
    return () => {
      loadSeq.current++ // drop any read still in flight
      releaseUrl()
    }
  }, [load])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '4px 8px',
          borderBottom: '1px solid var(--ra-border)',
          background: 'var(--ra-bg-raised)',
          minHeight: 28
        }}
      >
        <span
          title={path}
          style={{
            fontFamily: 'var(--ra-mono)',
            fontSize: 11.5,
            color: 'var(--ra-text-dim)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis'
          }}
        >
          {path}
        </span>
        <div style={{ flex: 1 }} />
        {state.phase === 'ready' && (
          <span style={{ flexShrink: 0, fontSize: 10.5, color: 'var(--ra-text-faint)' }}>
            {new Date(state.mtimeMs).toLocaleString()}
          </span>
        )}
        <button
          className='ra-btn'
          style={{ padding: '1px 7px', fontSize: 11 }}
          title='Reload from server'
          onClick={() => void load()}
        >
          ↻
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {state.phase === 'ready' && (
          <iframe
            key={state.url}
            src={state.url}
            title={path}
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }}
          />
        )}
        {state.phase === 'loading' && <div style={centerStyle}>Loading…</div>}
        {state.phase === 'error' && (
          <div style={{ ...centerStyle, color: 'var(--ra-red)' }}>{state.message}</div>
        )}
      </div>
    </div>
  )
}
