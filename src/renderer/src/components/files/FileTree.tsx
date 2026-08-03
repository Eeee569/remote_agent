import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitStatus, TreeEntry } from '@shared/domain'
import { api } from '@/api'
import { useConnectionStore } from '@/stores/connection'
import { useFilesStore } from '@/stores/files'

export interface FileTreeProps {
  hostId: string
  rootPath: string
  sessionId: string
  gitRoot?: string
}

interface NodeState {
  entries?: TreeEntry[]
  expanded: boolean
  loading: boolean
  error?: string
}

interface Badge {
  letter: string
  color: string
}

const GIT_POLL_MS = 5000
const UNTRACKED_COLOR = '#8fa8c9' // grey-blue

function isDirLike(e: TreeEntry): boolean {
  return e.type === 'dir' || (e.type === 'symlink' && e.linkTargetType === 'dir')
}

function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const da = isDirLike(a) ? 0 : 1
    const db = isDirLike(b) ? 0 : 1
    if (da !== db) return da - db
    return a.name.localeCompare(b.name)
  })
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Lazy-loading remote directory tree with git status badges. Single click on
 * a file opens it in the session's viewer panel (via the files store).
 */
export default function FileTree({
  hostId,
  rootPath,
  sessionId,
  gitRoot
}: FileTreeProps): React.JSX.Element {
  const [nodes, setNodes] = useState<Record<string, NodeState>>({})
  const [git, setGit] = useState<GitStatus | null>(null)
  const [copied, setCopied] = useState(false)
  const openFile = useFilesStore((s) => s.openFile)
  const mounted = useRef(true)
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes

  const gitBase = gitRoot && gitRoot.trim() !== '' ? gitRoot : rootPath

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const loadDir = useCallback(
    async (path: string): Promise<void> => {
      setNodes((n) => ({
        ...n,
        [path]: { ...(n[path] ?? {}), expanded: true, loading: true, error: undefined }
      }))
      try {
        const entries = sortEntries(await api.fsLsTree(hostId, path))
        if (!mounted.current) return
        setNodes((n) => ({
          ...n,
          [path]: { ...(n[path] ?? { expanded: true }), entries, loading: false }
        }))
      } catch (err) {
        if (!mounted.current) return
        setNodes((n) => ({
          ...n,
          [path]: { ...(n[path] ?? { expanded: true }), loading: false, error: errText(err) }
        }))
      }
    },
    [hostId]
  )

  const refreshGit = useCallback(async (): Promise<void> => {
    try {
      const status = await api.gitStatus(hostId, gitBase)
      if (mounted.current) setGit(status)
    } catch {
      // transient failure — keep the last known status
    }
  }, [hostId, gitBase])

  const refreshAll = useCallback(async (): Promise<void> => {
    void refreshGit()
    const expanded = Object.entries(nodesRef.current)
      .filter(([, v]) => v.expanded)
      .map(([k]) => k)
    const targets = expanded.length > 0 ? expanded : [rootPath]
    await Promise.all(targets.map((p) => loadDir(p)))
  }, [refreshGit, loadDir, rootPath])

  // root load (and reset when the root changes)
  useEffect(() => {
    setNodes({})
    void loadDir(rootPath)
  }, [rootPath, loadDir])

  // git polling while the document is visible
  useEffect(() => {
    void refreshGit()
    const iv = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshGit()
    }, GIT_POLL_MS)
    return () => window.clearInterval(iv)
  }, [refreshGit])

  // refresh after the host reconnects
  const connStatus = useConnectionStore((s) => s.statusByHost[hostId]?.status)
  const prevStatusRef = useRef(connStatus)
  useEffect(() => {
    const prev = prevStatusRef.current
    prevStatusRef.current = connStatus
    if (connStatus === 'connected' && prev !== undefined && prev !== 'connected') {
      void refreshAll()
    }
  }, [connStatus, refreshAll])

  const badges = useMemo(() => {
    const byPath = new Map<string, Badge>()
    const dirs = new Set<string>()
    if (!git?.isRepo) return { byPath, dirs }
    const base = gitBase.replace(/\/+$/, '')
    const add = (rel: string, letter: string, color: string): void => {
      const abs = base + '/' + rel
      if (!byPath.has(abs)) byPath.set(abs, { letter, color })
      let d = abs
      for (;;) {
        const idx = d.lastIndexOf('/')
        if (idx <= 0) break
        d = d.slice(0, idx)
        if (d.length <= base.length) break
        dirs.add(d)
      }
    }
    // modified wins over staged when a file is both
    for (const p of git.modified) add(p, 'M', 'var(--ra-yellow)')
    for (const p of git.staged) add(p, 'S', 'var(--ra-green)')
    for (const p of git.untracked) add(p, 'U', UNTRACKED_COLOR)
    return { byPath, dirs }
  }, [git, gitBase])

  const toggleDir = (path: string): void => {
    const node = nodesRef.current[path]
    if (node?.expanded) {
      setNodes((n) => ({ ...n, [path]: { ...(n[path] as NodeState), expanded: false } }))
      return
    }
    if (node?.entries) {
      setNodes((n) => ({ ...n, [path]: { ...(n[path] as NodeState), expanded: true } }))
      return
    }
    if (!node?.loading) void loadDir(path)
  }

  const copyRoot = (): void => {
    void navigator.clipboard.writeText(rootPath).then(() => {
      setCopied(true)
      window.setTimeout(() => {
        if (mounted.current) setCopied(false)
      }, 1500)
    })
  }

  const renderChildren = (path: string, depth: number): React.JSX.Element | null => {
    const node = nodes[path]
    if (!node) return null
    const pad = 8 + depth * 14
    return (
      <>
        {node.loading && !node.entries && (
          <div style={{ padding: `2px 8px 2px ${pad + 14}px`, color: 'var(--ra-text-faint)', fontSize: 12 }}>
            Loading…
          </div>
        )}
        {node.error && (
          <div
            style={{
              padding: `2px 8px 2px ${pad + 14}px`,
              color: 'var(--ra-red)',
              fontSize: 11.5,
              whiteSpace: 'pre-wrap'
            }}
          >
            {node.error}
          </div>
        )}
        {node.entries?.map((entry) => {
          const dir = isDirLike(entry)
          const child = nodes[entry.path]
          const badge = badges.byPath.get(entry.path)
          const dirDirty = dir && badges.dirs.has(entry.path)
          return (
            <div key={entry.path}>
              <div
                onClick={() => {
                  if (dir) toggleDir(entry.path)
                  else openFile(sessionId, entry.path)
                }}
                title={entry.path}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: `2px 8px 2px ${pad}px`,
                  cursor: 'pointer',
                  fontSize: 12.5,
                  color: dir ? 'var(--ra-text)' : 'var(--ra-text-dim)',
                  userSelect: 'none'
                }}
              >
                <span
                  style={{
                    width: 10,
                    flexShrink: 0,
                    fontSize: 10,
                    color: 'var(--ra-text-faint)'
                  }}
                >
                  {dir ? (child?.expanded ? '▾' : '▸') : ''}
                </span>
                <span style={{ flexShrink: 0, fontSize: 11 }}>
                  {entry.type === 'symlink' ? '🔗' : dir ? (child?.expanded ? '📂' : '📁') : '📄'}
                </span>
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    color: badge ? badge.color : undefined
                  }}
                >
                  {entry.name}
                </span>
                {badge && (
                  <span
                    style={{
                      flexShrink: 0,
                      marginLeft: 'auto',
                      paddingRight: 2,
                      fontSize: 10.5,
                      fontWeight: 700,
                      color: badge.color
                    }}
                  >
                    {badge.letter}
                  </span>
                )}
                {!badge && dirDirty && (
                  <span
                    style={{
                      flexShrink: 0,
                      marginLeft: 'auto',
                      paddingRight: 2,
                      fontSize: 9,
                      color: 'var(--ra-text-faint)'
                    }}
                  >
                    ●
                  </span>
                )}
              </div>
              {dir && child?.expanded && renderChildren(entry.path, depth + 1)}
            </div>
          )
        })}
        {node.entries && node.entries.length === 0 && (
          <div style={{ padding: `2px 8px 2px ${pad + 14}px`, color: 'var(--ra-text-faint)', fontSize: 12 }}>
            empty
          </div>
        )}
      </>
    )
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 8px',
          borderBottom: '1px solid var(--ra-border)',
          background: 'var(--ra-bg-raised)'
        }}
      >
        <span
          title={rootPath}
          style={{
            flex: 1,
            minWidth: 0,
            fontFamily: 'var(--ra-mono)',
            fontSize: 11,
            color: 'var(--ra-text-dim)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            direction: 'rtl',
            textAlign: 'left'
          }}
        >
          {rootPath}
        </span>
        <button
          className='ra-btn'
          style={{ padding: '1px 7px', fontSize: 11 }}
          title='Copy path'
          onClick={copyRoot}
        >
          {copied ? '✓' : 'Copy'}
        </button>
        <button
          className='ra-btn'
          style={{ padding: '1px 7px', fontSize: 11 }}
          title='Refresh tree and git status'
          onClick={() => void refreshAll()}
        >
          ↻
        </button>
      </div>
      {git?.isRepo && (
        <div
          style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '3px 10px',
            borderBottom: '1px solid var(--ra-border)',
            fontSize: 11,
            color: 'var(--ra-text-dim)',
            fontFamily: 'var(--ra-mono)'
          }}
        >
          <span style={{ color: 'var(--ra-accent)' }}>⎇ {git.branch ?? 'detached'}</span>
          {(git.ahead > 0 || git.behind > 0) && (
            <span>
              {git.ahead > 0 ? `↑${git.ahead}` : ''}
              {git.behind > 0 ? `↓${git.behind}` : ''}
            </span>
          )}
        </div>
      )}
      <div style={{ flex: 1, overflow: 'auto', padding: '4px 0' }}>
        {renderChildren(rootPath, 0)}
      </div>
    </div>
  )
}
