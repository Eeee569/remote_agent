/**
 * Form editor for settings.json / settings.local.json. Only keys the user
 * actually touches are patched onto the parsed object, so unknown keys always
 * survive a save. Falls back to the raw JSON editor on parse errors and via
 * an explicit toggle. Also exports the KvEditor / StringListEditor controls
 * reused by the MCP servers editor.
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { SettingsTarget } from '@shared/domain'
import RawJsonEditor from './RawJsonEditor'
import {
  filenameForKind,
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

// ---------------- reusable controls ----------------

export function KvEditor(props: {
  rows: KvRow[]
  onChange: (rows: KvRow[]) => void
  keyPlaceholder?: string
  valuePlaceholder?: string
}): React.JSX.Element {
  const { rows, onChange } = props
  const update = (id: string, patch: Partial<KvRow>): void =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((r) => (
        <div key={r.id} style={{ display: 'flex', gap: 6 }}>
          <input
            className='ra-input'
            style={{ flex: 2, minWidth: 0, fontFamily: 'var(--ra-mono)', fontSize: 12 }}
            value={r.key}
            placeholder={props.keyPlaceholder ?? 'KEY'}
            spellCheck={false}
            onChange={(e) => update(r.id, { key: e.target.value })}
          />
          <input
            className='ra-input'
            style={{ flex: 3, minWidth: 0, fontFamily: 'var(--ra-mono)', fontSize: 12 }}
            value={r.value}
            placeholder={props.valuePlaceholder ?? 'value'}
            spellCheck={false}
            onChange={(e) => update(r.id, { value: e.target.value })}
          />
          <button
            className='ra-btn'
            title='Remove row'
            onClick={() => onChange(rows.filter((x) => x.id !== r.id))}
          >
            ×
          </button>
        </div>
      ))}
      <div>
        <button
          className='ra-btn'
          onClick={() => onChange([...rows, { id: crypto.randomUUID(), key: '', value: '' }])}
        >
          + Add
        </button>
      </div>
    </div>
  )
}

export function StringListEditor(props: {
  items: string[]
  onChange: (items: string[]) => void
  placeholder?: string
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const add = (): void => {
    const v = draft.trim()
    if (v === '') return
    if (!props.items.includes(v)) props.onChange([...props.items, v])
    setDraft('')
  }
  return (
    <div>
      {props.items.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
          {props.items.map((it, i) => (
            <span
              key={`${it}-${i}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontFamily: 'var(--ra-mono)',
                fontSize: 11.5,
                background: 'var(--ra-bg-hover)',
                border: '1px solid var(--ra-border-strong)',
                borderRadius: 999,
                padding: '2px 9px',
                wordBreak: 'break-all'
              }}
            >
              {it}
              <span
                title='Remove'
                style={{ cursor: 'pointer', color: 'var(--ra-text-faint)' }}
                onClick={() => props.onChange(props.items.filter((_, j) => j !== i))}
              >
                ×
              </span>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          className='ra-input'
          style={{ flex: 1, minWidth: 0, fontFamily: 'var(--ra-mono)', fontSize: 12 }}
          value={draft}
          placeholder={props.placeholder}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
        />
        <button className='ra-btn' onClick={add}>
          Add
        </button>
      </div>
    </div>
  )
}

// ---------------- small pieces ----------------

function Field(props: { label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ marginBottom: 14 }}>
      <label className='ra-label'>{props.label}</label>
      {props.children}
      {props.hint !== undefined && (
        <div style={{ fontSize: 11, color: 'var(--ra-text-faint)', marginTop: 3 }}>{props.hint}</div>
      )}
    </div>
  )
}

type TriState = '' | 'true' | 'false'

function TriStateCheckbox(props: { value: TriState; onChange: (v: TriState) => void }): React.JSX.Element {
  const ref = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = props.value === ''
  }, [props.value])
  const next: TriState = props.value === '' ? 'true' : props.value === 'true' ? 'false' : ''
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
      <input ref={ref} type='checkbox' checked={props.value === 'true'} onChange={() => props.onChange(next)} />
      <span style={{ fontSize: 12.5, color: 'var(--ra-text-dim)' }}>
        {props.value === '' ? 'unset (inherit)' : props.value === 'true' ? 'enabled' : 'disabled'}
      </span>
    </label>
  )
}

const MODEL_SUGGESTIONS = ['claude-opus-5', 'claude-sonnet-5', 'sonnet', 'opus', 'haiku']
const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk']

// ---------------- the form ----------------

interface SettingsFormEditorProps {
  target: SettingsTarget
}

export default function SettingsFormEditor({ target }: SettingsFormEditorProps): React.JSX.Element {
  const file = useSettingsFile(target)
  const modelListId = useId()
  const [rawMode, setRawMode] = useState(false)
  const [base, setBase] = useState<Record<string, unknown> | null>(null)
  const [parseError, setParseError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [touched, setTouched] = useState<Set<string>>(new Set())

  const [model, setModel] = useState('')
  const [permissionMode, setPermissionMode] = useState('')
  const [envRows, setEnvRows] = useState<KvRow[]>([])
  const [allow, setAllow] = useState<string[]>([])
  const [ask, setAsk] = useState<string[]>([])
  const [deny, setDeny] = useState<string[]>([])
  const [addDirs, setAddDirs] = useState<string[]>([])
  const [enableAll, setEnableAll] = useState<TriState>('')
  const [enabledMcp, setEnabledMcp] = useState<string[]>([])
  const [disabledMcp, setDisabledMcp] = useState<string[]>([])

  const initFrom = (content: string): void => {
    const parsed = parseJsonLoose(content)
    if (parsed.obj === null) {
      setParseError(parsed.error ?? 'invalid JSON')
      setBase(null)
      return
    }
    const obj = parsed.obj
    setParseError(null)
    setBase(obj)
    setTouched(new Set())
    setModel(typeof obj.model === 'string' ? obj.model : '')
    setPermissionMode(typeof obj.permissionMode === 'string' ? obj.permissionMode : '')
    setEnvRows(kvRowsFrom(obj.env))
    const perms = isRecord(obj.permissions) ? obj.permissions : {}
    setAllow(stringList(perms.allow))
    setAsk(stringList(perms.ask))
    setDeny(stringList(perms.deny))
    setAddDirs(stringList(perms.additionalDirectories))
    setEnableAll(
      obj.enableAllProjectMcpServers === true
        ? 'true'
        : obj.enableAllProjectMcpServers === false
          ? 'false'
          : ''
    )
    setEnabledMcp(stringList(obj.enabledMcpjsonServers))
    setDisabledMcp(stringList(obj.disabledMcpjsonServers))
  }

  // re-seed the form whenever the underlying file (re)loads or is saved
  useEffect(() => {
    if (!file.loading && file.error === null) initFrom(file.content)
  }, [file.loading, file.error, file.content])

  const touch = (key: string): void =>
    setTouched((prev) => {
      const next = new Set(prev)
      next.add(key)
      return next
    })

  const setPermSub = (
    obj: Record<string, unknown>,
    key: string,
    list: string[]
  ): void => {
    const perms = isRecord(obj.permissions) ? { ...obj.permissions } : {}
    if (list.length > 0) perms[key] = [...list]
    else delete perms[key]
    if (Object.keys(perms).length > 0) obj.permissions = perms
    else delete obj.permissions
  }

  const buildPatched = (baseObj: Record<string, unknown>): Record<string, unknown> => {
    const obj = structuredClone(baseObj)
    if (touched.has('model')) {
      if (model.trim() !== '') obj.model = model.trim()
      else delete obj.model
    }
    if (touched.has('permissionMode')) {
      if (permissionMode !== '') obj.permissionMode = permissionMode
      else delete obj.permissionMode
    }
    if (touched.has('env')) {
      const env = kvRowsToObject(envRows)
      if (Object.keys(env).length > 0) obj.env = env
      else delete obj.env
    }
    if (touched.has('permissions.allow')) setPermSub(obj, 'allow', allow)
    if (touched.has('permissions.ask')) setPermSub(obj, 'ask', ask)
    if (touched.has('permissions.deny')) setPermSub(obj, 'deny', deny)
    if (touched.has('permissions.additionalDirectories')) {
      setPermSub(obj, 'additionalDirectories', addDirs)
    }
    if (touched.has('enableAllProjectMcpServers')) {
      if (enableAll === '') delete obj.enableAllProjectMcpServers
      else obj.enableAllProjectMcpServers = enableAll === 'true'
    }
    if (touched.has('enabledMcpjsonServers')) {
      if (enabledMcp.length > 0) obj.enabledMcpjsonServers = [...enabledMcp]
      else delete obj.enabledMcpjsonServers
    }
    if (touched.has('disabledMcpjsonServers')) {
      if (disabledMcp.length > 0) obj.disabledMcpjsonServers = [...disabledMcp]
      else delete obj.disabledMcpjsonServers
    }
    return obj
  }

  const saveNow = async (): Promise<void> => {
    if (base === null || saving) return
    setSaving(true)
    try {
      const ok = await file.save(stringifyStable(buildPatched(base)))
      if (ok) setTouched(new Set())
    } finally {
      setSaving(false)
    }
  }

  const filename = filenameForKind(target.file)
  const dirty = touched.size > 0

  if (rawMode) {
    return (
      <div>
        <div style={pathLineStyle}>{file.path}</div>
        <RawJsonEditor target={target} filenameHint={filename} />
        <div style={{ marginTop: 8 }}>
          <button
            className='ra-btn'
            onClick={() => {
              setRawMode(false)
              void file.reload()
            }}
          >
            Back to form view
          </button>
        </div>
      </div>
    )
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

  if (parseError !== null) {
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
          Cannot show the form — {filename} is not valid JSON ({parseError}). Fix it below.
        </div>
        <RawJsonEditor target={target} filenameHint={filename} />
      </div>
    )
  }

  const hooks = base !== null && isRecord(base.hooks) ? base.hooks : null
  const hookEvents = hooks !== null ? Object.keys(hooks).length : 0
  const hookGroups =
    hooks !== null
      ? Object.values(hooks).reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 0), 0)
      : 0

  return (
    <div style={{ maxWidth: 640 }}>
      <div style={pathLineStyle}>
        {file.path}
        {!file.exists ? ' (will be created on save)' : ''}
      </div>

      <Field label='Model' hint='Default model for sessions in this scope; leave empty to inherit'>
        <input
          className='ra-input'
          style={{ width: '100%', fontFamily: 'var(--ra-mono)', fontSize: 12 }}
          list={modelListId}
          value={model}
          placeholder='(unset)'
          spellCheck={false}
          onChange={(e) => {
            setModel(e.target.value)
            touch('model')
          }}
        />
        <datalist id={modelListId}>
          {MODEL_SUGGESTIONS.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </Field>

      <Field label='Permission mode'>
        <select
          className='ra-input'
          style={{ width: '100%' }}
          value={permissionMode}
          onChange={(e) => {
            setPermissionMode(e.target.value)
            touch('permissionMode')
          }}
        >
          <option value=''>(unset)</option>
          {PERMISSION_MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </Field>

      <Field label='Environment variables' hint='Applied to every Claude Code session'>
        <KvEditor
          rows={envRows}
          onChange={(rows) => {
            setEnvRows(rows)
            touch('env')
          }}
          keyPlaceholder='OPENAI_API_KEY'
          valuePlaceholder='value'
        />
      </Field>

      <Field label='Permissions — allow'>
        <StringListEditor
          items={allow}
          onChange={(items) => {
            setAllow(items)
            touch('permissions.allow')
          }}
          placeholder='Bash(npm run *)'
        />
      </Field>

      <Field label='Permissions — ask'>
        <StringListEditor
          items={ask}
          onChange={(items) => {
            setAsk(items)
            touch('permissions.ask')
          }}
          placeholder='Bash(git push *)'
        />
      </Field>

      <Field label='Permissions — deny'>
        <StringListEditor
          items={deny}
          onChange={(items) => {
            setDeny(items)
            touch('permissions.deny')
          }}
          placeholder='Read(./.env)'
        />
      </Field>

      <Field label='Additional directories' hint='Extra directories Claude Code may access'>
        <StringListEditor
          items={addDirs}
          onChange={(items) => {
            setAddDirs(items)
            touch('permissions.additionalDirectories')
          }}
          placeholder='../shared-lib'
        />
      </Field>

      <Field label='Enable all project MCP servers'>
        <TriStateCheckbox
          value={enableAll}
          onChange={(v) => {
            setEnableAll(v)
            touch('enableAllProjectMcpServers')
          }}
        />
      </Field>

      <Field label='Enabled .mcp.json servers'>
        <StringListEditor
          items={enabledMcp}
          onChange={(items) => {
            setEnabledMcp(items)
            touch('enabledMcpjsonServers')
          }}
          placeholder='mcp__codex__* or server name'
        />
      </Field>

      <Field label='Disabled .mcp.json servers'>
        <StringListEditor
          items={disabledMcp}
          onChange={(items) => {
            setDisabledMcp(items)
            touch('disabledMcpjsonServers')
          }}
          placeholder='server name'
        />
      </Field>

      <Field label='Hooks'>
        <div style={{ fontSize: 12.5, color: 'var(--ra-text-dim)' }}>
          {hookEvents > 0
            ? `${hookEvents} event${hookEvents === 1 ? '' : 's'}, ${hookGroups} matcher group${hookGroups === 1 ? '' : 's'} configured — edit as JSON`
            : 'No hooks configured — edit as JSON to add'}
        </div>
      </Field>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderTop: '1px solid var(--ra-border)',
          paddingTop: 12,
          marginTop: 4
        }}
      >
        <button className='ra-btn' onClick={() => setRawMode(true)}>
          Raw JSON
        </button>
        {dirty && <span style={{ color: 'var(--ra-yellow)', fontSize: 12 }}>unsaved changes</span>}
        <div style={{ flex: 1 }} />
        <button className='ra-btn' disabled={!dirty || saving} onClick={() => initFrom(file.content)}>
          Revert
        </button>
        <button className='ra-btn primary' disabled={!dirty || saving} onClick={() => void saveNow()}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
