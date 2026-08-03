/**
 * Raw text editor for a remote Claude Code config file, backed by Monaco with
 * the registered JSON schemas (model uri ends with the real filename so the
 * schema fileMatch applies). Also exports MonacoBuffer, the lazy Monaco
 * wrapper reused by the agents and CLAUDE.md editors.
 */
import { useEffect, useRef, useState } from 'react'
import type * as monacoNs from 'monaco-editor'
import type { SettingsTarget } from '@shared/domain'
import { pathLineStyle, useSettingsFile } from './settings-util'

// ---------------- MonacoBuffer ----------------

export interface MonacoBufferProps {
  /**
   * Baseline document. Parent should feed edits back via onChange so this
   * stays equal to the editor content; when it diverges (revert/reload) the
   * editor is reset to it.
   */
  value: string
  language: string
  /** Optional model uri, e.g. 'ra-settings:///home/u/.claude/settings.json' */
  modelUri?: string
  height?: number | string
  onChange?: (next: string) => void
  onSaveShortcut?: () => void
  onMarkers?: (count: number, firstMessage: string | null) => void
}

/** Lazy Monaco editor bound to the shared 'ra-dark' theme. */
export function MonacoBuffer(props: MonacoBufferProps): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<monacoNs.editor.IStandaloneCodeEditor | null>(null)
  const modelRef = useRef<monacoNs.editor.ITextModel | null>(null)
  const valueRef = useRef(props.value)
  const onChangeRef = useRef(props.onChange)
  const onSaveRef = useRef(props.onSaveShortcut)
  const onMarkersRef = useRef(props.onMarkers)
  onChangeRef.current = props.onChange
  onSaveRef.current = props.onSaveShortcut
  onMarkersRef.current = props.onMarkers

  const { modelUri, language } = props

  useEffect(() => {
    let disposed = false
    const disposables: monacoNs.IDisposable[] = []
    void (async () => {
      const { getMonaco } = await import('@/monaco-setup')
      if (disposed || !hostRef.current) return
      const monaco = getMonaco()
      let model: monacoNs.editor.ITextModel
      if (modelUri) {
        const uri = monaco.Uri.parse(modelUri)
        // a leftover model from a previous mount would make createModel throw
        monaco.editor.getModel(uri)?.dispose()
        model = monaco.editor.createModel(valueRef.current, language, uri)
      } else {
        model = monaco.editor.createModel(valueRef.current, language)
      }
      modelRef.current = model
      const editor = monaco.editor.create(hostRef.current, {
        model,
        theme: 'ra-dark',
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 12,
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        wordWrap: language === 'markdown' ? 'on' : 'off',
        fixedOverflowWidgets: true,
        tabSize: 2,
        padding: { top: 8 }
      })
      editorRef.current = editor
      disposables.push(
        model.onDidChangeContent(() => {
          onChangeRef.current?.(model.getValue())
        })
      )
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        onSaveRef.current?.()
      })
      if (onMarkersRef.current) {
        const pushMarkers = (): void => {
          const markers = monaco.editor.getModelMarkers({ resource: model.uri })
          onMarkersRef.current?.(markers.length, markers.length > 0 ? markers[0].message : null)
        }
        disposables.push(
          monaco.editor.onDidChangeMarkers((uris) => {
            if (uris.some((u) => u.toString() === model.uri.toString())) pushMarkers()
          })
        )
        pushMarkers()
      }
    })()
    return () => {
      disposed = true
      for (const d of disposables) d.dispose()
      editorRef.current?.dispose()
      editorRef.current = null
      modelRef.current?.dispose()
      modelRef.current = null
    }
  }, [modelUri, language])

  useEffect(() => {
    valueRef.current = props.value
    const model = modelRef.current
    if (model && model.getValue() !== props.value) model.setValue(props.value)
  }, [props.value])

  return (
    <div
      ref={hostRef}
      style={{
        height: props.height ?? 320,
        border: '1px solid var(--ra-border)',
        borderRadius: 'var(--ra-radius)',
        overflow: 'hidden'
      }}
    />
  )
}

// ---------------- RawJsonEditor ----------------

interface RawJsonEditorProps {
  target: SettingsTarget
  /** shown in the toolbar; also the uri fallback while the path resolves */
  filenameHint: string
}

export default function RawJsonEditor({ target, filenameHint }: RawJsonEditorProps): React.JSX.Element {
  const file = useSettingsFile(target)
  const [doc, setDoc] = useState<string | null>(null)
  const [savedDoc, setSavedDoc] = useState('')
  const [saving, setSaving] = useState(false)
  const [markerCount, setMarkerCount] = useState(0)
  const [firstMarker, setFirstMarker] = useState<string | null>(null)
  const docRef = useRef<string | null>(null)

  useEffect(() => {
    if (!file.loading && file.error === null) {
      setDoc(file.content)
      docRef.current = file.content
      setSavedDoc(file.content)
    }
  }, [file.loading, file.error, file.content])

  const dirty = doc !== null && doc !== savedDoc
  const language = target.file === 'claudeMd' ? 'markdown' : 'json'

  const saveNow = async (): Promise<void> => {
    const current = docRef.current
    if (current === null || saving) return
    setSaving(true)
    try {
      const ok = await file.save(current)
      if (ok) setSavedDoc(current)
    } finally {
      setSaving(false)
    }
  }

  if (file.loading) {
    return <div style={{ color: 'var(--ra-text-faint)', padding: '12px 0' }}>Loading…</div>
  }
  if (file.error !== null) {
    return (
      <div style={{ padding: '12px 0' }}>
        <span style={{ color: 'var(--ra-red)', marginRight: 10 }}>{file.error}</span>
        <button className='ra-btn' onClick={() => void file.reload()}>
          Retry
        </button>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontFamily: 'var(--ra-mono)', fontSize: 12, color: 'var(--ra-text-dim)' }}>
          {filenameHint}
          {!file.exists && !dirty ? ' (new file)' : ''}
        </span>
        {dirty && (
          <span title='Unsaved changes' style={{ color: 'var(--ra-yellow)', fontSize: 14, lineHeight: 1 }}>
            ●
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button className='ra-btn' disabled={!dirty || saving} onClick={() => setDoc(savedDoc)}>
          Revert
        </button>
        <button className='ra-btn primary' disabled={!dirty || saving} onClick={() => void saveNow()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <MonacoBuffer
        value={doc ?? ''}
        language={language}
        modelUri={'ra-settings://' + (file.path !== '' ? file.path : '/' + filenameHint)}
        height={380}
        onChange={(next) => {
          docRef.current = next
          setDoc(next)
        }}
        onSaveShortcut={() => void saveNow()}
        onMarkers={
          language === 'json'
            ? (count, first) => {
                setMarkerCount(count)
                setFirstMarker(first)
              }
            : undefined
        }
      />
      {language === 'json' && (
        <div
          style={{
            marginTop: 6,
            fontSize: 11.5,
            fontFamily: 'var(--ra-mono)',
            color: markerCount > 0 ? 'var(--ra-yellow)' : 'var(--ra-text-faint)',
            wordBreak: 'break-word'
          }}
        >
          {markerCount > 0
            ? `${markerCount} problem${markerCount === 1 ? '' : 's'} — ${firstMarker ?? ''}`
            : 'No schema problems'}
        </div>
      )}
      <div style={{ ...pathLineStyle, marginTop: 4 }}>
        Cmd/Ctrl+S saves — {file.path}
      </div>
    </div>
  )
}
