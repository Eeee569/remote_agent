import { useEffect, useRef, useState } from 'react'
import type * as Monaco from 'monaco-editor'
import { api } from '@/api'
import { useUiStore } from '@/stores/ui'
import MarkdownPreview from '@/components/files/MarkdownPreview'
import { AUTOSAVE_DEBOUNCE_MS, remoteChangedSince } from '@/components/files/autosave'

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
/** uri string -> mtime of the last content we read or wrote ourselves */
const knownMtimeByUri = new Map<string, number>()
/** uris whose loaded text is only the read-capped prefix of the remote file */
const truncatedUris = new Set<string>()
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
  knownMtimeByUri.delete(uri)
  truncatedUris.delete(uri)
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

/** What the status chip in the header reports about the buffer. */
type SaveState = 'idle' | 'saving' | 'saved' | 'conflict' | 'error'

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
  const blurSubRef = useRef<Monaco.IDisposable | null>(null)
  const monacoRef = useRef<typeof Monaco | null>(null)
  const disposedRef = useRef(false)
  const dirtyRef = useRef(false)
  const autosaveTimerRef = useRef<number | null>(null)
  const savingRef = useRef(false)
  // files open editable; only truncated reads force read-only, because
  // writing back a capped prefix would destroy the rest of the file
  const editingRef = useRef(true)

  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState('')
  const [info, setInfo] = useState<LoadedInfo | null>(null)
  const [dirty, setDirty] = useState(false)
  const [editing, setEditing] = useState(true)
  const [saveState, setSaveState] = useState<SaveState>('idle')
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [saveError, setSaveError] = useState('')
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

  const setEditingEnabled = (value: boolean): void => {
    editingRef.current = value
    setEditing(value)
    editorRef.current?.updateOptions({ readOnly: !value })
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

  const cancelAutosave = (): void => {
    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }
  }

  /**
   * Write the buffer to the server. Autosaves stand down when the file has
   * changed underneath us (an agent editing the same file, say) and say so
   * instead; an explicit save asks before overwriting.
   */
  const save = async (opts: { auto: boolean }): Promise<void> => {
    cancelAutosave()
    const model = editorRef.current?.getModel()
    if (!model || !dirtyRef.current) return
    if (savingRef.current) {
      // a write is already in flight; try again once it lands, or these
      // keystrokes would sit unsaved until the next change
      scheduleAutosaveRef.current()
      return
    }
    if (truncatedUris.has(uri)) {
      // writing back the read-capped prefix would destroy the rest of the file
      if (!opts.auto) addToast('error', `${basename(path)} is truncated; saving is disabled`)
      return
    }

    const value = model.getValue()
    savingRef.current = true
    if (!disposedRef.current) setSaveState('saving')
    try {
      const known = knownMtimeByUri.get(uri)
      if (known !== undefined) {
        const st = await api.fsStat(hostId, path)
        if (remoteChangedSince(known, st?.mtimeMs ?? null)) {
          if (opts.auto) {
            if (!disposedRef.current) setSaveState('conflict')
            return
          }
          const ok = window.confirm(
            `${basename(path)} changed on the server since you opened it.\n\n` +
              'Overwrite it with your version?'
          )
          if (!ok) {
            if (!disposedRef.current) setSaveState('conflict')
            return
          }
        }
      }
      const st = await api.fsWrite(hostId, path, new TextEncoder().encode(value))
      savedTextByUri.set(uri, value)
      knownMtimeByUri.set(uri, st.mtimeMs)
      if (disposedRef.current) return
      // typing during the write leaves the buffer dirty again
      const current = editorRef.current?.getModel()?.getValue()
      markDirty(current !== undefined && current !== value)
      setSaveState('saved')
      setSavedAt(Date.now())
    } catch (err) {
      if (disposedRef.current) return
      setSaveState('error')
      setSaveError(errText(err))
      if (!opts.auto) addToast('error', `Save failed: ${errText(err)}`)
    } finally {
      savingRef.current = false
    }
  }
  const saveRef = useRef(save)
  saveRef.current = save

  const scheduleAutosave = (): void => {
    cancelAutosave()
    if (!editingRef.current || truncatedUris.has(uri)) return
    autosaveTimerRef.current = window.setTimeout(() => {
      autosaveTimerRef.current = null
      void saveRef.current({ auto: true })
    }, AUTOSAVE_DEBOUNCE_MS)
  }
  const scheduleAutosaveRef = useRef(scheduleAutosave)
  scheduleAutosaveRef.current = scheduleAutosave

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
      void saveRef.current({ auto: false })
    })
    changeSubRef.current = editor.onDidChangeModelContent(() => {
      const m = editor.getModel()
      if (!m) return
      const value = m.getValue()
      setText(value)
      const isDirty = value !== savedTextByUri.get(uri)
      markDirty(isDirty)
      if (isDirty) {
        setSaveState('idle')
        scheduleAutosaveRef.current()
      }
    })
    // leaving the editor commits straight away, like an IDE's "save on focus
    // loss" — no waiting out the debounce
    blurSubRef.current = editor.onDidBlurEditorText(() => {
      if (dirtyRef.current) void saveRef.current({ auto: true })
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
        if (truncatedUris.has(uri)) setEditingEnabled(false)
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
      knownMtimeByUri.set(uri, res.mtimeMs)
      if (loadedInfo.truncated) {
        truncatedUris.add(uri)
        setEditingEnabled(false)
      } else {
        truncatedUris.delete(uri)
      }
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
      // closing the tab, switching files, or hiding the panel must not lose
      // edits: fire the write and let it finish without us
      cancelAutosave()
      if (dirtyRef.current) void saveRef.current({ auto: true })
      disposedRef.current = true
      changeSubRef.current?.dispose()
      changeSubRef.current = null
      blurSubRef.current?.dispose()
      blurSubRef.current = null
      editorRef.current?.dispose()
      editorRef.current = null
    }
    // the component is keyed per hostId+path by its parent
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, path])

  // the app losing focus (or being hidden) commits too
  useEffect(() => {
    const flush = (): void => {
      if (dirtyRef.current) void saveRef.current({ auto: true })
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('blur', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', flush)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const toggleEditing = (): void => {
    const next = !editingRef.current
    setEditingEnabled(next)
    if (next && isMarkdown) setMdView('source')
  }

  const reload = (): void => {
    if (dirtyRef.current && !window.confirm('Discard unsaved changes and reload from server?')) {
      return
    }
    void load({ keepDirty: false })
  }

  // a reattached model carries no info, so the flag save() checks is the source of truth
  const truncated = info?.truncated === true || truncatedUris.has(uri)
  const showEditor = phase === 'text' && (!isMarkdown || mdView === 'source')
  const smallBtn: React.CSSProperties = { padding: '1px 7px', fontSize: 11 }

  // autosave means the header reports state rather than offering a button;
  // the only cases needing a decision are a conflict or a failed write
  const chipStyle = (color: string): React.CSSProperties => ({
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 5,
    fontSize: 10.5,
    color
  })
  let statusChip: React.JSX.Element | null = null
  if (phase === 'text') {
    if (saveState === 'conflict') {
      statusChip = (
        <span style={chipStyle('var(--ra-yellow)')}>
          <span title='Someone (or an agent) wrote this file after you opened it'>
            changed on server
          </span>
          <button className='ra-btn' style={smallBtn} onClick={reload}>
            Reload
          </button>
          <button
            className='ra-btn'
            style={smallBtn}
            title='Overwrite the server copy with your version'
            onClick={() => void save({ auto: false })}
          >
            Overwrite
          </button>
        </span>
      )
    } else if (saveState === 'error') {
      statusChip = (
        <span style={chipStyle('var(--ra-red)')}>
          <span title={saveError}>save failed</span>
          <button className='ra-btn' style={smallBtn} onClick={() => void save({ auto: false })}>
            Retry
          </button>
        </span>
      )
    } else if (saveState === 'saving') {
      statusChip = <span style={chipStyle('var(--ra-text-dim)')}>saving…</span>
    } else if (dirty) {
      statusChip = (
        <span style={chipStyle('var(--ra-accent)')} title='Unsaved edits — saving shortly'>
          ●
        </span>
      )
    } else if (savedAt !== null) {
      statusChip = (
        <span
          style={chipStyle('var(--ra-text-faint)')}
          title={`Saved at ${new Date(savedAt).toLocaleTimeString()}`}
        >
          saved
        </span>
      )
    }
  }

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
        {truncated && (
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
        {statusChip}
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
        {phase === 'text' && !truncated && (
          <button
            className='ra-btn'
            style={{
              ...smallBtn,
              ...(editing
                ? { borderColor: 'var(--ra-accent)', color: 'var(--ra-accent)' }
                : {})
            }}
            title={
              editing
                ? 'Editable — click to protect this file from edits'
                : 'Read-only — click to edit'
            }
            onClick={toggleEditing}
          >
            {editing ? '✎' : '🔒'}
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
