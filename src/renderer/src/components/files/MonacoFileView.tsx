import { useEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import { api } from '@/api'
import { useUiStore } from '@/stores/ui'
import MarkdownPreview from '@/components/files/MarkdownPreview'

export interface MonacoFileViewProps {
  hostId: string
  path: string
  sessionId: string
  /** lets the viewer's tab strip show a dirty dot */
  onDirtyChange?: (path: string, dirty: boolean) => void
}

// ---------------- module-level model bookkeeping ----------------

/** uri string -> last text loaded from / saved to the server */
const savedTextByUri = new Map<string, string>()
let monacoLoaded = false
let tsDiagnosticsRelaxed = false

export function fileUri(hostId: string, path: string): string {
  return 'ra://' + hostId + path
}

/**
 * Dispose the cached Monaco model for a closed file. No-op (beyond map
 * cleanup) when Monaco was never loaded in this window.
 */
export async function disposeFileModel(hostId: string, path: string): Promise<void> {
  const uri = fileUri(hostId, path)
  savedTextByUri.delete(uri)
  if (!monacoLoaded) return
  try {
    const monacoMod = await import('@/monaco-setup')
    const monaco = monacoMod.getMonaco()
    monaco.editor.getModel(monaco.Uri.parse(uri))?.dispose()
  } catch {
    // model already gone
  }
}

// ---------------- helpers ----------------

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  py: 'python',
  md: 'markdown',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  cpp: 'cpp',
  h: 'c',
  css: 'css',
  html: 'html',
  sh: 'shell',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  sql: 'sql',
  rb: 'ruby',
  php: 'php'
}

function languageOf(path: string): string {
  const name = path.split('/').pop() ?? ''
  const idx = name.lastIndexOf('.')
  const ext = idx >= 0 ? name.slice(idx + 1).toLowerCase() : ''
  return LANG_BY_EXT[ext] ?? 'plaintext'
}

function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000)
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0) return true
  }
  return false
}

function middleEllipsis(text: string, max: number): string {
  if (text.length <= max) return text
  const half = Math.floor((max - 1) / 2)
  return text.slice(0, half) + '…' + text.slice(text.length - half)
}

function basename(p: string): string {
  return p.replace(/\/+$/, '').split('/').pop() ?? p
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

type Phase = 'loading' | 'text' | 'binary' | 'error'

interface LoadedInfo {
  truncated: boolean
  size: number
  mtimeMs: number
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
 * Read-only-by-default Monaco viewer for one remote file. Monaco itself is
 * lazy-imported so it stays out of the initial renderer chunk. Instantiated
 * once per open file (keyed by the parent), models cached per uri.
 */
export default function MonacoFileView(props: MonacoFileViewProps): React.JSX.Element {
  const { hostId, path, onDirtyChange } = props
  const uri = fileUri(hostId, path)
  const isMarkdown = /\.(md|markdown)$/i.test(path)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null)
  const changeSubRef = useRef<Monaco.IDisposable | null>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const disposedRef = useRef(false)
  const dirtyRef = useRef(false)
  const editingRef = useRef(false)

  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState('')
  const [info, setInfo] = useState<LoadedInfo | null>(null)
  const [dirty, setDirty] = useState(false)
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [mdView, setMdView] = useState<'preview' | 'source'>('preview')
  const addToast = useUiStore((s) => s.addToast)

  const onDirtyChangeRef = useRef(onDirtyChange)
  onDirtyChangeRef.current = onDirtyChange

  const markDirty = (value: boolean): void => {
    if (dirtyRef.current === value) return
    dirtyRef.current = value
    setDirty(value)
    onDirtyChangeRef.current?.(path, value)
  }

  const ensureMonaco = async (): Promise<typeof Monaco> => {
    if (monacoRef.current) return monacoRef.current
    const monacoMod = await import('@/monaco-setup')
    const monaco = monacoMod.getMonaco()
    monacoRef.current = monaco
    monacoLoaded = true
    if (!tsDiagnosticsRelaxed) {
      // monaco-setup registers only the json + generic editor workers, so
      // silence the ts/js language services to avoid worker-mismatch errors
      tsDiagnosticsRelaxed = true
      try {
        const opts = { noSemanticValidation: true, noSyntaxValidation: true }
        monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(opts)
        monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(opts)
      } catch {
        // language service not present in this build
      }
    }
    return monaco
  }

  const save = async (): Promise<void> => {
    const model = editorRef.current?.getModel()
    if (!model || !dirtyRef.current) return
    try {
      const value = model.getValue()
      await api.fsWrite(hostId, path, new TextEncoder().encode(value))
      savedTextByUri.set(uri, value)
      markDirty(false)
      addToast('success', `Saved ${basename(path)}`)
    } catch (err) {
      addToast('error', `Save failed: ${errText(err)}`)
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save

  const attachEditor = (monaco: typeof Monaco, model: Monaco.editor.ITextModel): void => {
    const el = containerRef.current
    if (!el) return
    if (editorRef.current) {
      if (editorRef.current.getModel() !== model) editorRef.current.setModel(model)
      return
    }
    const mono =
      getComputedStyle(document.documentElement).getPropertyValue('--ra-mono').trim() || 'monospace'
    const editor = monaco.editor.create(el, {
      model,
      readOnly: !editingRef.current,
      theme: 'ra-dark',
      minimap: { enabled: false },
      fontSize: 12.5,
      fontFamily: mono,
      automaticLayout: true,
      scrollBeyondLastLine: false,
      renderWhitespace: 'none',
      padding: { top: 8 }
    })
    editorRef.current = editor
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveRef.current()
    })
    changeSubRef.current = editor.onDidChangeModelContent(() => {
      const m = editor.getModel()
      if (!m) return
      const value = m.getValue()
      setText(value)
      markDirty(value !== savedTextByUri.get(uri))
    })
  }

  const load = async (opts: { keepDirty: boolean }): Promise<void> => {
    setPhase('loading')
    setError('')
    try {
      const monaco = await ensureMonaco()
      if (disposedRef.current) return
      const modelUri = monaco.Uri.parse(uri)
      const existing = monaco.editor.getModel(modelUri)
      const saved = savedTextByUri.get(uri)
      if (opts.keepDirty && existing && saved !== undefined && existing.getValue() !== saved) {
        // an earlier mount left unsaved edits — keep them instead of reloading
        attachEditor(monaco, existing)
        setText(existing.getValue())
        markDirty(true)
        setPhase('text')
        return
      }
      const res = await api.fsRead(hostId, path)
      if (disposedRef.current) return
      const loadedInfo: LoadedInfo = { truncated: res.truncated, size: res.size, mtimeMs: res.mtimeMs }
      if (looksBinary(res.data)) {
        setInfo(loadedInfo)
        setPhase('binary')
        return
      }
      const content = new TextDecoder('utf-8').decode(res.data)
      let model = monaco.editor.getModel(modelUri)
      if (!model) {
        model = monaco.editor.createModel(content, languageOf(path), modelUri)
      } else if (model.getValue() !== content) {
        model.setValue(content)
      }
      savedTextByUri.set(uri, content)
      attachEditor(monaco, model)
      setText(content)
      setInfo(loadedInfo)
      markDirty(false)
      setPhase('text')
    } catch (err) {
      if (disposedRef.current) return
      setError(errText(err))
      setPhase('error')
    }
  }

  useEffect(() => {
    disposedRef.current = false
    void load({ keepDirty: true })
    return () => {
      disposedRef.current = true
      changeSubRef.current?.dispose()
      changeSubRef.current = null
      editorRef.current?.dispose()
      editorRef.current = null
    }
    // the component is keyed per hostId+path by its parent
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, path])

  const toggleEditing = (): void => {
    const next = !editingRef.current
    editingRef.current = next
    setEditing(next)
    editorRef.current?.updateOptions({ readOnly: !next })
    if (next && isMarkdown) setMdView('source')
  }

  const reload = (): void => {
    if (dirtyRef.current && !window.confirm('Discard unsaved changes and reload from server?')) {
      return
    }
    void load({ keepDirty: false })
  }

  const showEditor = phase === 'text' && (!isMarkdown || mdView === 'source')
  const smallBtn: React.CSSProperties = { padding: '1px 7px', fontSize: 11 }

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
          {middleEllipsis(path, 72)}
        </span>
        {info?.truncated && (
          <span
            title='The file is larger than the read limit; showing the beginning only. Editing is disabled.'
            style={{
              flexShrink: 0,
              fontSize: 10.5,
              color: 'var(--ra-yellow)',
              border: '1px solid var(--ra-yellow)',
              borderRadius: 4,
              padding: '0 6px',
              lineHeight: '15px'
            }}
          >
            truncated
          </span>
        )}
        {dirty && (
          <span style={{ flexShrink: 0, color: 'var(--ra-accent)', fontSize: 10 }}>●</span>
        )}
        <div style={{ flex: 1 }} />
        {isMarkdown && phase === 'text' && (
          <div
            style={{
              display: 'flex',
              border: '1px solid var(--ra-border-strong)',
              borderRadius: 5,
              overflow: 'hidden',
              flexShrink: 0
            }}
          >
            {(['preview', 'source'] as const).map((v) => (
              <span
                key={v}
                onClick={() => setMdView(v)}
                style={{
                  padding: '1px 9px',
                  fontSize: 11,
                  cursor: 'pointer',
                  userSelect: 'none',
                  background: mdView === v ? 'var(--ra-bg-active)' : 'transparent',
                  color: mdView === v ? 'var(--ra-text)' : 'var(--ra-text-dim)'
                }}
              >
                {v === 'preview' ? 'Preview' : 'Source'}
              </span>
            ))}
          </div>
        )}
        {info && (
          <span style={{ flexShrink: 0, fontSize: 10.5, color: 'var(--ra-text-faint)' }}>
            {new Date(info.mtimeMs).toLocaleString()}
          </span>
        )}
        <button className='ra-btn' style={smallBtn} title='Reload from server' onClick={reload}>
          ↻
        </button>
        {phase === 'text' && !info?.truncated && (
          <button
            className='ra-btn'
            style={{
              ...smallBtn,
              ...(editing
                ? { borderColor: 'var(--ra-accent)', color: 'var(--ra-accent)' }
                : {})
            }}
            title={editing ? 'Disable editing' : 'Enable editing'}
            onClick={toggleEditing}
          >
            ✎
          </button>
        )}
        {dirty && (
          <button
            className='ra-btn primary'
            style={smallBtn}
            title='Save to server (Cmd/Ctrl+S)'
            onClick={() => void save()}
          >
            Save
          </button>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div
          ref={containerRef}
          style={{ position: 'absolute', inset: 0, display: showEditor ? 'block' : 'none' }}
        />
        {phase === 'text' && isMarkdown && mdView === 'preview' && (
          <div style={{ position: 'absolute', inset: 0, overflow: 'auto' }}>
            <MarkdownPreview content={text} />
          </div>
        )}
        {phase === 'loading' && <div style={centerStyle}>Loading…</div>}
        {phase === 'binary' && (
          <div style={centerStyle}>binary file ({info?.size ?? 0} bytes)</div>
        )}
        {phase === 'error' && (
          <div style={{ ...centerStyle, color: 'var(--ra-red)' }}>{error}</div>
        )}
      </div>
    </div>
  )
}
