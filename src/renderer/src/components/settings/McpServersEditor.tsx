/**
 * Card-based editor for the project's .mcp.json MCP server registry.
 * Patches only the mcpServers entry being edited; every other key in the
 * file (and unknown keys inside a server entry) survives a save.
 */
import { useState } from 'react'
import type { SettingsTarget } from '@shared/domain'
import RawJsonEditor from './RawJsonEditor'
import { KvEditor } from './SettingsFormEditor'
import {
  cardStyle,
  chipStyle,
  isRecord,
  kvRowsFrom,
  kvRowsToObject,
  parseJsonLoose,
  pathLineStyle,
  stringList,
  stringifyStable,
  useSettingsFile
} from './settings-util'
import type { KvRow } from './settings-util'

const NAME_RE = /^[a-zA-Z0-9_-]+$/
const TRANSPORTS = ['stdio', 'http', 'sse', 'ws'] as const
type Transport = (typeof TRANSPORTS)[number]

interface ServerDraft {
  /** null when adding a new server */
  originalName: string | null
  name: string
  transport: Transport
  command: string
  argsText: string
  envRows: KvRow[]
  url: string
  headerRows: KvRow[]
  timeout: string
}

function transportOf(entry: Record<string, unknown>): Transport {
  if (typeof entry.type === 'string' && (TRANSPORTS as readonly string[]).includes(entry.type)) {
    return entry.type as Transport
  }
  if (typeof entry.command === 'string') return 'stdio'
  if (typeof entry.url === 'string') return 'http'
  return 'stdio'
}

function draftFrom(name: string, entry: Record<string, unknown>): ServerDraft {
  const transport = transportOf(entry)
  return {
    originalName: name,
    name,
    transport,
    command: typeof entry.command === 'string' ? entry.command : '',
    argsText: stringList(entry.args).join('\n'),
    envRows: kvRowsFrom(entry.env),
    url: typeof entry.url === 'string' ? entry.url : '',
    headerRows: kvRowsFrom(entry.headers),
    timeout: typeof entry.timeout === 'number' ? String(entry.timeout) : ''
  }
}

function emptyDraft(): ServerDraft {
  return {
    originalName: null,
    name: '',
    transport: 'stdio',
    command: '',
    argsText: '',
    envRows: [],
    url: '',
    headerRows: [],
    timeout: ''
  }
}

interface McpServersEditorProps {
  hostId: string
  repoPath: string
}

export default function McpServersEditor({ hostId, repoPath }: McpServersEditorProps): React.JSX.Element {
  const target: SettingsTarget = { hostId, scope: 'project', projectPath: repoPath, file: 'mcp' }
  const file = useSettingsFile(target)
  const [draft, setDraft] = useState<ServerDraft | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

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

  const parsed = parseJsonLoose(file.content)
  if (parsed.obj === null) {
    return (
      <div>
        <div style={pathLineStyle}>{file.path}</div>
        <div
          style={{
            border: '1px solid var(--ra-yellow)',
            color: 'var(--ra-yellow)',
            borderRadius: 'var(--ra-radius)',
            padding: '8px 10px',
            fontSize: 12,
            marginBottom: 10
          }}
        >
          .mcp.json is not valid JSON ({parsed.error ?? 'parse error'}). Fix it below.
        </div>
        <RawJsonEditor target={target} filenameHint='.mcp.json' />
      </div>
    )
  }

  const servers: Array<[string, Record<string, unknown>]> = isRecord(parsed.obj.mcpServers)
    ? Object.entries(parsed.obj.mcpServers).filter((e): e is [string, Record<string, unknown>] =>
        isRecord(e[1])
      )
    : []

  const writeServers = async (
    mutate: (serversMap: Record<string, unknown>) => void
  ): Promise<boolean> => {
    const baseParsed = parseJsonLoose(file.content)
    const obj = structuredClone(baseParsed.obj ?? {})
    const map = isRecord(obj.mcpServers) ? obj.mcpServers : {}
    mutate(map)
    obj.mcpServers = map
    return file.save(stringifyStable(obj))
  }

  const saveDraft = async (): Promise<void> => {
    if (draft === null || saving) return
    const name = draft.name.trim()
    if (!NAME_RE.test(name)) {
      setDraftError('Name must match [a-zA-Z0-9_-]+')
      return
    }
    if (
      draft.originalName !== name &&
      servers.some(([n]) => n === name)
    ) {
      setDraftError(`A server named "${name}" already exists`)
      return
    }
    if (draft.transport === 'stdio' && draft.command.trim() === '') {
      setDraftError('Command is required for stdio transport')
      return
    }
    if (draft.transport !== 'stdio' && draft.url.trim() === '') {
      setDraftError('URL is required for this transport')
      return
    }
    setDraftError(null)
    setSaving(true)
    try {
      const ok = await writeServers((map) => {
        const prev = draft.originalName !== null ? map[draft.originalName] : undefined
        const entry: Record<string, unknown> = isRecord(prev) ? structuredClone(prev) : {}
        entry.type = draft.transport
        if (draft.transport === 'stdio') {
          entry.command = draft.command.trim()
          const args = draft.argsText
            .split('\n')
            .map((s) => s.trim())
            .filter((s) => s !== '')
          if (args.length > 0) entry.args = args
          else delete entry.args
          const env = kvRowsToObject(draft.envRows)
          if (Object.keys(env).length > 0) entry.env = env
          else delete entry.env
          delete entry.url
          delete entry.headers
        } else {
          entry.url = draft.url.trim()
          const headers = kvRowsToObject(draft.headerRows)
          if (Object.keys(headers).length > 0) entry.headers = headers
          else delete entry.headers
          delete entry.command
          delete entry.args
          delete entry.env
        }
        const t = draft.timeout.trim()
        if (t !== '' && !Number.isNaN(Number(t))) entry.timeout = Number(t)
        else delete entry.timeout
        if (draft.originalName !== null && draft.originalName !== name) {
          delete map[draft.originalName]
        }
        map[name] = entry
      })
      if (ok) setDraft(null)
    } finally {
      setSaving(false)
    }
  }

  const deleteServer = async (name: string): Promise<void> => {
    setSaving(true)
    try {
      await writeServers((map) => {
        delete map[name]
      })
      setConfirmingDelete(null)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 680 }}>
      <div style={pathLineStyle}>
        {file.path}
        {!file.exists ? ' (will be created on save)' : ''}
      </div>

      {servers.length === 0 && (
        <div style={{ color: 'var(--ra-text-faint)', margin: '4px 0 12px' }}>
          No MCP servers configured for this project.
        </div>
      )}

      {servers.map(([name, entry]) => {
        const transport = transportOf(entry)
        const envCount = isRecord(entry.env) ? Object.keys(entry.env).length : 0
        const headerCount = isRecord(entry.headers) ? Object.keys(entry.headers).length : 0
        return (
          <div key={name} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <strong style={{ fontFamily: 'var(--ra-mono)', fontSize: 13 }}>{name}</strong>
              <span style={{ ...chipStyle, color: 'var(--ra-accent)', borderColor: 'var(--ra-accent)' }}>
                {transport}
              </span>
              <div style={{ flex: 1 }} />
              <button
                className='ra-btn'
                disabled={saving}
                onClick={() => {
                  setDraftError(null)
                  setDraft(draftFrom(name, entry))
                }}
              >
                Edit
              </button>
              {confirmingDelete === name ? (
                <>
                  <button className='ra-btn danger' disabled={saving} onClick={() => void deleteServer(name)}>
                    Confirm
                  </button>
                  <button className='ra-btn' disabled={saving} onClick={() => setConfirmingDelete(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button className='ra-btn danger' disabled={saving} onClick={() => setConfirmingDelete(name)}>
                  Delete
                </button>
              )}
            </div>
            <div
              style={{
                fontFamily: 'var(--ra-mono)',
                fontSize: 12,
                color: 'var(--ra-text-dim)',
                marginTop: 6,
                wordBreak: 'break-all'
              }}
            >
              {transport === 'stdio'
                ? [typeof entry.command === 'string' ? entry.command : '', ...stringList(entry.args)]
                    .filter((s) => s !== '')
                    .join(' ')
                : typeof entry.url === 'string'
                  ? entry.url
                  : ''}
            </div>
            <div style={{ fontSize: 11, color: 'var(--ra-text-faint)', marginTop: 4 }}>
              {transport === 'stdio' ? `${envCount} env var${envCount === 1 ? '' : 's'}` : `${headerCount} header${headerCount === 1 ? '' : 's'}`}
              {typeof entry.timeout === 'number' ? ` · timeout ${entry.timeout}` : ''}
            </div>
          </div>
        )
      })}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
        <button
          className='ra-btn primary'
          onClick={() => {
            setDraftError(null)
            setDraft(emptyDraft())
          }}
        >
          Add server
        </button>
        <span style={{ fontSize: 11.5, color: 'var(--ra-text-faint)' }}>
          Tip: use the Codex sub-agent wizard to add OpenAI Codex here in one click
        </span>
      </div>

      {draft !== null && (
        <div
          className='ra-dialog-backdrop'
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setDraft(null)
          }}
        >
          <div className='ra-dialog' style={{ width: 520 }}>
            <h2>{draft.originalName !== null ? `Edit server "${draft.originalName}"` : 'Add MCP server'}</h2>

            <div style={{ marginBottom: 12 }}>
              <label className='ra-label'>Name</label>
              <input
                className='ra-input'
                style={{ width: '100%', fontFamily: 'var(--ra-mono)', fontSize: 12 }}
                value={draft.name}
                placeholder='codex'
                spellCheck={false}
                autoFocus={draft.originalName === null}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </div>

            <div style={{ marginBottom: 12 }}>
              <label className='ra-label'>Transport</label>
              <select
                className='ra-input'
                style={{ width: '100%' }}
                value={draft.transport}
                onChange={(e) => setDraft({ ...draft, transport: e.target.value as Transport })}
              >
                {TRANSPORTS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            {draft.transport === 'stdio' ? (
              <>
                <div style={{ marginBottom: 12 }}>
                  <label className='ra-label'>Command</label>
                  <input
                    className='ra-input'
                    style={{ width: '100%', fontFamily: 'var(--ra-mono)', fontSize: 12 }}
                    value={draft.command}
                    placeholder='codex'
                    spellCheck={false}
                    onChange={(e) => setDraft({ ...draft, command: e.target.value })}
                  />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label className='ra-label'>Args (one per line)</label>
                  <textarea
                    className='ra-input'
                    style={{
                      width: '100%',
                      minHeight: 64,
                      fontFamily: 'var(--ra-mono)',
                      fontSize: 12,
                      resize: 'vertical'
                    }}
                    value={draft.argsText}
                    placeholder={'mcp-server'}
                    spellCheck={false}
                    onChange={(e) => setDraft({ ...draft, argsText: e.target.value })}
                  />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label className='ra-label'>Environment variables</label>
                  <KvEditor
                    rows={draft.envRows}
                    onChange={(rows) => setDraft({ ...draft, envRows: rows })}
                    keyPlaceholder='OPENAI_API_KEY'
                  />
                </div>
              </>
            ) : (
              <>
                <div style={{ marginBottom: 12 }}>
                  <label className='ra-label'>URL</label>
                  <input
                    className='ra-input'
                    style={{ width: '100%', fontFamily: 'var(--ra-mono)', fontSize: 12 }}
                    value={draft.url}
                    placeholder='https://example.com/mcp'
                    spellCheck={false}
                    onChange={(e) => setDraft({ ...draft, url: e.target.value })}
                  />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label className='ra-label'>Headers</label>
                  <KvEditor
                    rows={draft.headerRows}
                    onChange={(rows) => setDraft({ ...draft, headerRows: rows })}
                    keyPlaceholder='Authorization'
                    valuePlaceholder='Bearer …'
                  />
                </div>
              </>
            )}

            <div style={{ marginBottom: 12 }}>
              <label className='ra-label'>Timeout (optional)</label>
              <input
                className='ra-input'
                style={{ width: 160 }}
                type='number'
                value={draft.timeout}
                placeholder='(none)'
                onChange={(e) => setDraft({ ...draft, timeout: e.target.value })}
              />
            </div>

            {draftError !== null && (
              <div style={{ color: 'var(--ra-red)', fontSize: 12, marginBottom: 10 }}>{draftError}</div>
            )}

            <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
              <div style={{ flex: 1 }} />
              <button className='ra-btn' onClick={() => setDraft(null)}>
                Cancel
              </button>
              <button className='ra-btn primary' disabled={saving} onClick={() => void saveDraft()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
