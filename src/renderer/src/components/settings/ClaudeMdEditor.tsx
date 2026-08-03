/**
 * CLAUDE.md editor: Monaco markdown editing plus a styled react-markdown
 * preview (default view when the file already has content).
 */
import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { SettingsTarget } from '@shared/domain'
import { MonacoBuffer } from './RawJsonEditor'
import { pathLineStyle, useSettingsFile } from './settings-util'

const MD_CSS = `
.ra-md-preview {
  font-size: 13px;
  line-height: 1.6;
  color: var(--ra-text);
  word-break: break-word;
}
.ra-md-preview h1, .ra-md-preview h2, .ra-md-preview h3,
.ra-md-preview h4, .ra-md-preview h5, .ra-md-preview h6 {
  margin: 18px 0 8px;
  font-weight: 600;
  line-height: 1.3;
}
.ra-md-preview h1 { font-size: 19px; border-bottom: 1px solid var(--ra-border); padding-bottom: 6px; }
.ra-md-preview h2 { font-size: 16px; border-bottom: 1px solid var(--ra-border); padding-bottom: 4px; }
.ra-md-preview h3 { font-size: 14px; }
.ra-md-preview h4, .ra-md-preview h5, .ra-md-preview h6 { font-size: 13px; }
.ra-md-preview p { margin: 8px 0; }
.ra-md-preview a { color: var(--ra-accent); text-decoration: none; }
.ra-md-preview a:hover { text-decoration: underline; }
.ra-md-preview code {
  font-family: var(--ra-mono);
  font-size: 12px;
  background: var(--ra-bg-hover);
  border-radius: 4px;
  padding: 1px 5px;
}
.ra-md-preview pre {
  background: var(--ra-bg);
  border: 1px solid var(--ra-border);
  border-radius: var(--ra-radius);
  padding: 10px 12px;
  overflow-x: auto;
  margin: 10px 0;
}
.ra-md-preview pre code { background: none; padding: 0; }
.ra-md-preview ul, .ra-md-preview ol { margin: 8px 0; padding-left: 24px; }
.ra-md-preview li { margin: 3px 0; }
.ra-md-preview blockquote {
  margin: 10px 0;
  padding: 2px 12px;
  border-left: 3px solid var(--ra-border-strong);
  color: var(--ra-text-dim);
}
.ra-md-preview table { border-collapse: collapse; margin: 10px 0; display: block; overflow-x: auto; }
.ra-md-preview th, .ra-md-preview td {
  border: 1px solid var(--ra-border);
  padding: 5px 10px;
  text-align: left;
}
.ra-md-preview th { background: var(--ra-bg-raised); font-weight: 600; }
.ra-md-preview hr { border: none; border-top: 1px solid var(--ra-border); margin: 16px 0; }
.ra-md-preview img { max-width: 100%; }
.ra-md-preview input[type='checkbox'] { margin-right: 6px; }
`

interface ClaudeMdEditorProps {
  target: SettingsTarget
}

export default function ClaudeMdEditor({ target }: ClaudeMdEditorProps): React.JSX.Element {
  const file = useSettingsFile(target)
  const [doc, setDoc] = useState<string | null>(null)
  const [savedDoc, setSavedDoc] = useState('')
  const [mode, setMode] = useState<'edit' | 'preview' | null>(null)
  const [saving, setSaving] = useState(false)
  const docRef = useRef<string | null>(null)

  useEffect(() => {
    if (!file.loading && file.error === null) {
      setDoc(file.content)
      docRef.current = file.content
      setSavedDoc(file.content)
      setMode((m) => m ?? (file.content.trim() !== '' ? 'preview' : 'edit'))
    }
  }, [file.loading, file.error, file.content])

  const dirty = doc !== null && doc !== savedDoc

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

  if (file.loading || mode === null) {
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
    return <div style={{ color: 'var(--ra-text-faint)', padding: '12px 0' }}>Loading…</div>
  }

  const modeBtn = (m: 'preview' | 'edit', label: string): React.JSX.Element => (
    <button
      className='ra-btn'
      style={
        mode === m
          ? { background: 'var(--ra-bg-active)', borderColor: 'var(--ra-accent)' }
          : undefined
      }
      onClick={() => setMode(m)}
    >
      {label}
    </button>
  )

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={pathLineStyle}>
        {file.path}
        {!file.exists && !dirty ? ' (does not exist yet)' : ''}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        {modeBtn('preview', 'Preview')}
        {modeBtn('edit', 'Edit')}
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

      {mode === 'edit' ? (
        <MonacoBuffer
          value={doc ?? ''}
          language='markdown'
          height={440}
          onChange={(next) => {
            docRef.current = next
            setDoc(next)
          }}
          onSaveShortcut={() => void saveNow()}
        />
      ) : (
        <div
          style={{
            border: '1px solid var(--ra-border)',
            borderRadius: 'var(--ra-radius)',
            background: 'var(--ra-bg-panel)',
            padding: '4px 18px 14px',
            minHeight: 120
          }}
        >
          <style>{MD_CSS}</style>
          {(doc ?? '').trim() === '' ? (
            <p style={{ color: 'var(--ra-text-faint)' }}>Empty — switch to Edit to add content.</p>
          ) : (
            <div className='ra-md-preview'>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc ?? ''}</ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
