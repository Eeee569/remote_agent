/**
 * List + editor for Claude Code agent definition files (.claude/agents/*.md).
 * The frontmatter form only rewrites the managed keys; unknown frontmatter
 * keys pass through untouched. The body is edited in Monaco (markdown).
 */
import { useCallback, useEffect, useId, useState } from 'react'
import { CODEX_WORKER_AGENT_MD } from '@shared/claude-schemas'
import { api } from '@/api'
import { useUiStore } from '@/stores/ui'
import { MonacoBuffer } from './RawJsonEditor'
import {
  cardStyle,
  chipStyle,
  errText,
  joinFrontmatter,
  pathLineStyle,
  splitFrontmatter,
  stringList
} from './settings-util'
import type { AgentFileInfo } from '@shared/domain'

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/
const MODEL_SUGGESTIONS = ['sonnet', 'opus', 'haiku', 'inherit']
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

interface AgentRowMeta {
  desc: string
  codex: boolean
}

interface EditorState {
  /** null while creating a new agent */
  existingName: string | null
  path: string
  name: string
  attrs: Record<string, unknown>
  description: string
  tools: string
  model: string
  permissionMode: string
  body: string
}

function editorFromContent(existingName: string | null, path: string, name: string, content: string): EditorState {
  const { attrs, body } = splitFrontmatter(content)
  const tools = Array.isArray(attrs.tools)
    ? stringList(attrs.tools).join(', ')
    : typeof attrs.tools === 'string'
      ? attrs.tools
      : ''
  return {
    existingName,
    path,
    name,
    attrs,
    description: typeof attrs.description === 'string' ? attrs.description : '',
    tools,
    model: typeof attrs.model === 'string' ? attrs.model : '',
    permissionMode: typeof attrs.permissionMode === 'string' ? attrs.permissionMode : '',
    body
  }
}

function CodexChip(): React.JSX.Element {
  return (
    <span style={{ ...chipStyle, color: 'var(--ra-purple)', borderColor: 'var(--ra-purple)' }}>
      delegates to Codex
    </span>
  )
}

export interface AgentsEditorProps {
  hostId: string
  scope: 'user' | 'project'
  projectPath?: string
}

export default function AgentsEditor({ hostId, scope, projectPath }: AgentsEditorProps): React.JSX.Element {
  const modelListId = useId()
  const [list, setList] = useState<AgentFileInfo[] | null>(null)
  const [meta, setMeta] = useState<Record<string, AgentRowMeta>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const loadList = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    try {
      const items = await api.agentsList(hostId, scope, projectPath)
      const metas: Record<string, AgentRowMeta> = {}
      await Promise.all(
        items.map(async (it) => {
          try {
            const res = await api.agentsRead(hostId, scope, it.name, projectPath)
            const { attrs } = splitFrontmatter(res.content)
            metas[it.name] = {
              desc: typeof attrs.description === 'string' ? attrs.description.split('\n')[0] : '',
              codex: res.content.includes('mcp__codex__')
            }
          } catch {
            metas[it.name] = { desc: '', codex: false }
          }
        })
      )
      setList(items)
      setMeta(metas)
    } catch (err) {
      const msg = errText(err)
      setLoadError(msg)
      useUiStore.getState().addToast('error', `Failed to list agents: ${msg}`)
    } finally {
      setLoading(false)
    }
  }, [hostId, scope, projectPath])

  useEffect(() => {
    setEditor(null)
    setMenuOpen(false)
    void loadList()
  }, [loadList])

  const openExisting = async (info: AgentFileInfo): Promise<void> => {
    try {
      const res = await api.agentsRead(hostId, scope, info.name, projectPath)
      setFormError(null)
      setConfirmingDelete(false)
      setEditor(editorFromContent(info.name, res.path, info.name, res.content))
    } catch (err) {
      useUiStore.getState().addToast('error', `Failed to read agent "${info.name}": ${errText(err)}`)
    }
  }

  const openNew = (template: 'blank' | 'codex'): void => {
    setMenuOpen(false)
    setFormError(null)
    setConfirmingDelete(false)
    if (template === 'codex') {
      setEditor(editorFromContent(null, '', 'codex-worker', CODEX_WORKER_AGENT_MD))
    } else {
      setEditor({
        existingName: null,
        path: '',
        name: '',
        attrs: {},
        description: '',
        tools: '',
        model: '',
        permissionMode: '',
        body: ''
      })
    }
  }

  const saveAgent = async (): Promise<void> => {
    if (editor === null || saving) return
    const name = editor.name.trim()
    if (!NAME_RE.test(name)) {
      setFormError('Name must match [a-z0-9][a-z0-9-]* (it becomes the filename)')
      return
    }
    if (editor.description.trim() === '') {
      setFormError('Description is required — Claude uses it to decide when to delegate')
      return
    }
    if (editor.existingName === null && (list ?? []).some((a) => a.name === name)) {
      setFormError(`An agent named "${name}" already exists`)
      return
    }
    setFormError(null)
    const attrs: Record<string, unknown> = { ...editor.attrs }
    attrs.name = name
    attrs.description = editor.description
    if (editor.tools.trim() !== '') attrs.tools = editor.tools.trim()
    else delete attrs.tools
    if (editor.model.trim() !== '') attrs.model = editor.model.trim()
    else delete attrs.model
    if (editor.permissionMode !== '') attrs.permissionMode = editor.permissionMode
    else delete attrs.permissionMode
    setSaving(true)
    try {
      await api.agentsWrite(hostId, scope, name, joinFrontmatter(attrs, editor.body), projectPath)
      useUiStore.getState().addToast('success', `Saved agent "${name}"`)
      await loadList()
      // loadList clears the editor via its effect only on scope change; keep editing
      const res = await api.agentsRead(hostId, scope, name, projectPath)
      setEditor(editorFromContent(name, res.path, name, res.content))
    } catch (err) {
      useUiStore.getState().addToast('error', `Failed to save agent "${name}": ${errText(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const deleteAgent = async (): Promise<void> => {
    if (editor === null || editor.existingName === null || saving) return
    setSaving(true)
    try {
      await api.agentsDelete(hostId, scope, editor.existingName, projectPath)
      useUiStore.getState().addToast('success', `Deleted agent "${editor.existingName}"`)
      setEditor(null)
      await loadList()
    } catch (err) {
      useUiStore.getState().addToast('error', `Failed to delete agent: ${errText(err)}`)
    } finally {
      setSaving(false)
    }
  }

  // ---------------- editor view ----------------

  if (editor !== null) {
    const mentionsCodex = `${editor.tools} ${editor.description}`.includes('mcp__codex__')
    return (
      <div style={{ maxWidth: 720 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <button className='ra-btn' onClick={() => setEditor(null)}>
            ← All agents
          </button>
          <strong style={{ fontSize: 13 }}>
            {editor.existingName !== null ? `Edit agent` : 'New agent'}
          </strong>
          {mentionsCodex && <CodexChip />}
        </div>
        {editor.path !== '' && <div style={pathLineStyle}>{editor.path}</div>}

        <div style={{ marginBottom: 12 }}>
          <label className='ra-label'>Name (filename)</label>
          <input
            className='ra-input'
            style={{ width: '100%', fontFamily: 'var(--ra-mono)', fontSize: 12 }}
            value={editor.name}
            placeholder='code-reviewer'
            spellCheck={false}
            disabled={editor.existingName !== null}
            onChange={(e) => setEditor({ ...editor, name: e.target.value })}
          />
          {editor.existingName !== null && (
            <div style={{ fontSize: 11, color: 'var(--ra-text-faint)', marginTop: 3 }}>
              Rename by creating a new agent and deleting this one
            </div>
          )}
        </div>

        <div style={{ marginBottom: 12 }}>
          <label className='ra-label'>Description (required)</label>
          <textarea
            className='ra-input'
            style={{ width: '100%', minHeight: 64, resize: 'vertical' }}
            value={editor.description}
            placeholder='When should Claude delegate to this agent?'
            onChange={(e) => setEditor({ ...editor, description: e.target.value })}
          />
        </div>

        <div style={{ marginBottom: 12 }}>
          <label className='ra-label'>Tools (comma list, optional)</label>
          <input
            className='ra-input'
            style={{ width: '100%', fontFamily: 'var(--ra-mono)', fontSize: 12 }}
            value={editor.tools}
            placeholder='Read, Grep, Bash'
            spellCheck={false}
            onChange={(e) => setEditor({ ...editor, tools: e.target.value })}
          />
        </div>

        <div style={{ display: 'flex', gap: 10, marginBottom: 12 }}>
          <div style={{ flex: 1 }}>
            <label className='ra-label'>Model (optional)</label>
            <input
              className='ra-input'
              style={{ width: '100%', fontFamily: 'var(--ra-mono)', fontSize: 12 }}
              list={modelListId}
              value={editor.model}
              placeholder='inherit'
              spellCheck={false}
              onChange={(e) => setEditor({ ...editor, model: e.target.value })}
            />
            <datalist id={modelListId}>
              {MODEL_SUGGESTIONS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
          <div style={{ flex: 1 }}>
            <label className='ra-label'>Permission mode (optional)</label>
            <select
              className='ra-input'
              style={{ width: '100%' }}
              value={editor.permissionMode}
              onChange={(e) => setEditor({ ...editor, permissionMode: e.target.value })}
            >
              <option value=''>(unset)</option>
              {PERMISSION_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div style={{ marginBottom: 12 }}>
          <label className='ra-label'>System prompt (markdown body)</label>
          <MonacoBuffer
            value={editor.body}
            language='markdown'
            height={300}
            onChange={(next) => setEditor((prev) => (prev !== null ? { ...prev, body: next } : prev))}
            onSaveShortcut={() => void saveAgent()}
          />
        </div>

        {formError !== null && (
          <div style={{ color: 'var(--ra-red)', fontSize: 12, marginBottom: 10 }}>{formError}</div>
        )}

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {editor.existingName !== null &&
            (confirmingDelete ? (
              <>
                <button className='ra-btn danger' disabled={saving} onClick={() => void deleteAgent()}>
                  Confirm delete
                </button>
                <button className='ra-btn' disabled={saving} onClick={() => setConfirmingDelete(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <button className='ra-btn danger' disabled={saving} onClick={() => setConfirmingDelete(true)}>
                Delete
              </button>
            ))}
          <div style={{ flex: 1 }} />
          <button className='ra-btn primary' disabled={saving} onClick={() => void saveAgent()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    )
  }

  // ---------------- list view ----------------

  return (
    <div style={{ maxWidth: 680 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, position: 'relative' }}>
        <button className='ra-btn primary' onClick={() => setMenuOpen((v) => !v)}>
          New agent ▾
        </button>
        {menuOpen && (
          <div
            style={{
              position: 'absolute',
              top: '100%',
              left: 0,
              marginTop: 4,
              background: 'var(--ra-bg-raised)',
              border: '1px solid var(--ra-border-strong)',
              borderRadius: 'var(--ra-radius)',
              boxShadow: '0 8px 24px rgba(0, 0, 0, 0.5)',
              zIndex: 10,
              minWidth: 220,
              overflow: 'hidden'
            }}
          >
            {(
              [
                ['blank', 'Blank'],
                ['codex', 'Codex worker (template)']
              ] as const
            ).map(([id, label]) => (
              <div
                key={id}
                style={{ padding: '8px 12px', cursor: 'pointer' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--ra-bg-hover)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                onClick={() => openNew(id)}
              >
                {label}
              </div>
            ))}
          </div>
        )}
        <button className='ra-btn' disabled={loading} onClick={() => void loadList()}>
          Refresh
        </button>
      </div>

      {loading && <div style={{ color: 'var(--ra-text-faint)' }}>Loading…</div>}
      {!loading && loadError !== null && (
        <div style={{ color: 'var(--ra-red)', fontSize: 12 }}>{loadError}</div>
      )}
      {!loading && loadError === null && (list ?? []).length === 0 && (
        <div style={{ color: 'var(--ra-text-faint)' }}>
          No agents in this scope yet — create one with “New agent”.
        </div>
      )}

      {(list ?? []).map((info) => (
        <div
          key={info.name}
          style={{ ...cardStyle, cursor: 'pointer' }}
          onClick={() => void openExisting(info)}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <strong style={{ fontFamily: 'var(--ra-mono)', fontSize: 13 }}>{info.name}</strong>
            {meta[info.name]?.codex === true && <CodexChip />}
          </div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--ra-text-dim)',
              marginTop: 4,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {meta[info.name]?.desc !== '' && meta[info.name] !== undefined
              ? meta[info.name].desc
              : 'no description'}
          </div>
        </div>
      ))}
    </div>
  )
}
