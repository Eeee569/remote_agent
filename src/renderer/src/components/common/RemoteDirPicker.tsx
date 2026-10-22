import { useCallback, useEffect, useRef, useState } from 'react'
import type { TreeEntry } from '@shared/domain'
import { api } from '@/api'
import PromptDialog from '@/components/common/PromptDialog'
import { joinPath, validName } from '@/components/files/path-util'
import { newFolderSpec } from '@/components/files/prompt-specs'
import type { PromptSpec } from '@/components/files/prompt-specs'

interface RemoteDirPickerProps {
  hostId: string
  initialPath?: string
  onPick: (path: string) => void
  onClose: () => void
  dirsOnly?: boolean
  /** Offer "New folder" in the directory being browsed; it opens once created. */
  allowCreate?: boolean
}

interface PromptState extends PromptSpec {
  onSubmit(value: string): void
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isDirLike(e: TreeEntry): boolean {
  return e.type === 'dir' || (e.type === 'symlink' && e.linkTargetType === 'dir')
}

function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return '/'
  return trimmed.slice(0, idx)
}

/** Modal for browsing the remote filesystem and picking a directory (or file). */
export default function RemoteDirPicker({
  hostId,
  initialPath,
  onPick,
  onClose,
  dirsOnly,
  allowCreate
}: RemoteDirPickerProps): React.JSX.Element {
  const [path, setPath] = useState<string>('')
  const [input, setInput] = useState<string>('')
  const [entries, setEntries] = useState<TreeEntry[]>([])
  /** every name in the directory, files included, for collision checks */
  const [names, setNames] = useState<string[]>([])
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [creating, setCreating] = useState(false)
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  /** List `target` and make it current; false when it could not be listed. */
  const navigate = useCallback(
    async (target: string): Promise<boolean> => {
      setLoading(true)
      setError(null)
      try {
        const list = await api.fsLsTree(hostId, target)
        if (!mounted.current) return false
        const filtered = dirsOnly ? list.filter(isDirLike) : [...list]
        filtered.sort((a, b) => {
          const da = isDirLike(a) ? 0 : 1
          const db = isDirLike(b) ? 0 : 1
          if (da !== db) return da - db
          return a.name.localeCompare(b.name)
        })
        setEntries(filtered)
        setNames(list.map((e) => e.name))
        setPath(target)
        setInput(target)
        setSelectedFile(null)
        return true
      } catch (err) {
        if (mounted.current) setError(errText(err))
        return false
      } finally {
        if (mounted.current) setLoading(false)
      }
    },
    [hostId, dirsOnly]
  )

  const createFolder = (): void => {
    const dir = path
    setPrompt({
      ...newFolderSpec(dir, names),
      onSubmit: (value) => {
        const name = validName(value)
        if (name === null) return
        setCreating(true)
        void (async () => {
          try {
            const created = await api.fsMkdir(hostId, joinPath(dir, name))
            if (mounted.current) await navigate(created)
          } catch (err) {
            if (mounted.current) setError(`Could not create folder: ${errText(err)}`)
          } finally {
            if (mounted.current) setCreating(false)
          }
        })()
      }
    })
  }


  useEffect(() => {
    void (async () => {
      try {
        const requested = initialPath?.trim() ?? ''
        if (requested !== '' && (await navigate(requested))) return
        // a typed path that does not exist yet still needs somewhere to
        // browse (and create) from — start at home and keep the error visible
        const failure = requested !== '' ? `Could not open ${requested}` : null
        const ok = await navigate(await api.fsHome(hostId))
        if (ok && failure !== null && mounted.current) setError(`${failure} — showing your home directory.`)
      } catch (err) {
        if (mounted.current) {
          setError(errText(err))
          setLoading(false)
        }
      }
    })()
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const segments = path.split('/').filter(Boolean)

  return (
    <div
      className='ra-dialog-backdrop'
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className='ra-dialog'
        style={{ width: 600, display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <h2>{dirsOnly ? 'Select directory' : 'Select file or directory'}</h2>

        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2, fontSize: 12 }}>
          <span
            onClick={() => void navigate('/')}
            style={{ cursor: 'pointer', color: 'var(--ra-accent)', padding: '1px 3px' }}
          >
            /
          </span>
          {segments.map((seg, i) => {
            const target = '/' + segments.slice(0, i + 1).join('/')
            const last = i === segments.length - 1
            return (
              <span key={target} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                <span
                  onClick={() => {
                    if (!last) void navigate(target)
                  }}
                  style={{
                    cursor: last ? 'default' : 'pointer',
                    color: last ? 'var(--ra-text)' : 'var(--ra-accent)',
                    padding: '1px 3px'
                  }}
                >
                  {seg}
                </span>
                {!last && <span style={{ color: 'var(--ra-text-faint)' }}>/</span>}
              </span>
            )
          })}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <input
            className='ra-input'
            style={{ flex: 1, fontFamily: 'var(--ra-mono)', fontSize: 12 }}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && input.trim() !== '') void navigate(input.trim())
            }}
            spellCheck={false}
            placeholder='/absolute/path'
          />
          <button
            className='ra-btn'
            onClick={() => {
              if (input.trim() !== '') void navigate(input.trim())
            }}
          >
            Go
          </button>
        </div>

        {error && (
          <div style={{ color: 'var(--ra-red)', fontSize: 12, whiteSpace: 'pre-wrap' }}>{error}</div>
        )}

        <div
          style={{
            border: '1px solid var(--ra-border)',
            borderRadius: 'var(--ra-radius)',
            background: 'var(--ra-bg)',
            height: 300,
            overflowY: 'auto'
          }}
        >
          {loading ? (
            <div style={{ padding: 12, color: 'var(--ra-text-dim)' }}>Loading…</div>
          ) : (
            <>
              {path !== '/' && path !== '' && (
                <div
                  onClick={() => void navigate(parentOf(path))}
                  style={{ padding: '4px 10px', cursor: 'pointer', color: 'var(--ra-text-dim)' }}
                >
                  📁 ..
                </div>
              )}
              {entries.map((entry) => {
                const dir = isDirLike(entry)
                const selected = !dir && entry.path === selectedFile
                return (
                  <div
                    key={entry.path}
                    onClick={() => {
                      if (dir) void navigate(entry.path)
                      else if (!dirsOnly) setSelectedFile(entry.path)
                    }}
                    style={{
                      padding: '4px 10px',
                      cursor: dir || !dirsOnly ? 'pointer' : 'default',
                      display: 'flex',
                      gap: 8,
                      alignItems: 'center',
                      background: selected ? 'var(--ra-bg-active)' : 'transparent',
                      color: dir ? 'var(--ra-text)' : 'var(--ra-text-dim)'
                    }}
                  >
                    <span>{dir ? '📁' : '📄'}</span>
                    <span
                      style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    >
                      {entry.name}
                    </span>
                  </div>
                )
              })}
              {entries.length === 0 && (
                <div style={{ padding: 12, color: 'var(--ra-text-faint)' }}>
                  {dirsOnly ? 'No subdirectories' : 'Empty directory'}
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {allowCreate && (
            <>
              <button
                className='ra-btn'
                disabled={loading || creating || path === ''}
                title={`Create a folder in ${path} and open it`}
                onClick={createFolder}
              >
                New folder…
              </button>
            </>
          )}
          <div style={{ flex: 1 }} />
          <button className='ra-btn' onClick={onClose}>
            Cancel
          </button>
          <button
            className='ra-btn primary'
            disabled={loading || creating || path === ''}
            onClick={() => onPick(selectedFile ?? path)}
          >
            Select
          </button>
        </div>
      </div>

      {prompt && (
        <PromptDialog
          key={prompt.title}
          title={prompt.title}
          label={prompt.label}
          initialValue={prompt.initialValue}
          confirmLabel={prompt.confirmLabel}
          placeholder={prompt.placeholder}
          validate={prompt.validate}
          onSubmit={(value) => {
            setPrompt(null)
            prompt.onSubmit(value)
          }}
          onCancel={() => setPrompt(null)}
        />
      )}
    </div>
  )
}
