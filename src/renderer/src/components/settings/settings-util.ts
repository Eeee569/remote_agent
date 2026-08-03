/**
 * Shared helpers for the settings/install UI: loose JSON parsing, stable
 * serialization, the useSettingsFile hook, agent-frontmatter split/join,
 * and small style constants used across this folder.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { load as yamlLoad, dump as yamlDump } from 'js-yaml'
import type { SettingsFileKind, SettingsTarget } from '@shared/domain'
import { api } from '@/api'
import { useUiStore } from '@/stores/ui'

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Coerce an unknown value to a string[] keeping only string members. */
export function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

export function filenameForKind(kind: SettingsFileKind): string {
  switch (kind) {
    case 'settings':
      return 'settings.json'
    case 'settingsLocal':
      return 'settings.local.json'
    case 'mcp':
      return '.mcp.json'
    case 'claudeMd':
      return 'CLAUDE.md'
  }
}

// ---------------- JSON helpers ----------------

/** Tolerant parse: empty/whitespace-only content parses to an empty object. */
export function parseJsonLoose(content: string): {
  obj: Record<string, unknown> | null
  error?: string
} {
  if (content.trim() === '') return { obj: {} }
  try {
    const parsed: unknown = JSON.parse(content)
    if (!isRecord(parsed)) return { obj: null, error: 'top-level JSON value is not an object' }
    return { obj: parsed }
  } catch (err) {
    return { obj: null, error: errText(err) }
  }
}

export function stringifyStable(obj: Record<string, unknown>): string {
  return JSON.stringify(obj, null, 2) + '\n'
}

// ---------------- frontmatter (agent .md files) ----------------

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

/**
 * Tolerant frontmatter split: no frontmatter (or unparseable YAML) yields
 * empty attrs and the untouched markdown as body.
 */
export function splitFrontmatter(md: string): { attrs: Record<string, unknown>; body: string } {
  const m = FRONTMATTER_RE.exec(md)
  if (!m) return { attrs: {}, body: md }
  try {
    const loaded: unknown = yamlLoad(m[1])
    if (!isRecord(loaded)) return { attrs: {}, body: md }
    return { attrs: loaded, body: md.slice(m[0].length).replace(/^\r?\n/, '') }
  } catch {
    return { attrs: {}, body: md }
  }
}

export function joinFrontmatter(attrs: Record<string, unknown>, body: string): string {
  const normalized = body === '' ? '' : body.endsWith('\n') ? body : body + '\n'
  return '---\n' + yamlDump(attrs) + '---\n\n' + normalized
}

// ---------------- key/value row model ----------------

export interface KvRow {
  id: string
  key: string
  value: string
}

export function kvRowsFrom(obj: unknown): KvRow[] {
  if (!isRecord(obj)) return []
  return Object.entries(obj).map(([key, value]) => ({
    id: crypto.randomUUID(),
    key,
    value: typeof value === 'string' ? value : JSON.stringify(value)
  }))
}

export function kvRowsToObject(rows: KvRow[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) {
    const k = r.key.trim()
    if (k !== '') out[k] = r.value
  }
  return out
}

// ---------------- useSettingsFile ----------------

export interface SettingsFile {
  content: string
  exists: boolean
  path: string
  loading: boolean
  error: string | null
  reload(): Promise<void>
  /** Writes `next`; returns true on success. Failures toast and return false. */
  save(next: string): Promise<boolean>
}

/** Load/save one remote Claude Code config file with toasts on failure. */
export function useSettingsFile(target: SettingsTarget): SettingsFile {
  const { hostId, scope, projectPath, file } = target
  const [content, setContent] = useState('')
  const [exists, setExists] = useState(false)
  const [path, setPath] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const seq = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    const mySeq = ++seq.current
    setLoading(true)
    setError(null)
    try {
      const res = await api.settingsRead({ hostId, scope, projectPath, file })
      if (seq.current !== mySeq) return
      setContent(res.content)
      setExists(res.exists)
      setPath(res.path)
    } catch (err) {
      if (seq.current !== mySeq) return
      const msg = errText(err)
      setError(msg)
      useUiStore.getState().addToast('error', `Failed to read ${filenameForKind(file)}: ${msg}`)
    } finally {
      if (seq.current === mySeq) setLoading(false)
    }
  }, [hostId, scope, projectPath, file])

  useEffect(() => {
    void reload()
  }, [reload])

  const save = useCallback(
    async (next: string): Promise<boolean> => {
      try {
        await api.settingsWrite({ hostId, scope, projectPath, file }, next)
        setContent(next)
        setExists(true)
        useUiStore.getState().addToast('success', `Saved ${filenameForKind(file)}`)
        return true
      } catch (err) {
        useUiStore
          .getState()
          .addToast('error', `Failed to save ${filenameForKind(file)}: ${errText(err)}`)
        return false
      }
    },
    [hostId, scope, projectPath, file]
  )

  return { content, exists, path, loading, error, reload, save }
}

// ---------------- shared styles ----------------

export const pathLineStyle: CSSProperties = {
  fontFamily: 'var(--ra-mono)',
  fontSize: 11,
  color: 'var(--ra-text-faint)',
  wordBreak: 'break-all',
  margin: '2px 0 12px'
}

export const cardStyle: CSSProperties = {
  background: 'var(--ra-bg-raised)',
  border: '1px solid var(--ra-border)',
  borderRadius: 8,
  padding: 14,
  marginBottom: 12
}

export const chipStyle: CSSProperties = {
  display: 'inline-block',
  fontSize: 10.5,
  lineHeight: '16px',
  padding: '0 7px',
  borderRadius: 999,
  border: '1px solid var(--ra-border-strong)',
  color: 'var(--ra-text-dim)',
  whiteSpace: 'nowrap'
}
