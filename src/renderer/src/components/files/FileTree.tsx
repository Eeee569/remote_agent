import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitStatus, TreeEntry } from '@shared/domain'
import { api } from '@/api'
import ContextMenu from '@/components/common/ContextMenu'
import type { MenuEntry } from '@/components/common/ContextMenu'
import PromptDialog from '@/components/common/PromptDialog'
import {
  moveSpec,
  newFileSpec,
  newFolderSpec,
  renameSpec
} from '@/components/files/prompt-specs'
import type { PromptSpec } from '@/components/files/prompt-specs'
import {
  ChevronIcon,
  FileIcon,
  FolderIcon,
  SymlinkBadge,
  fileIconColor
} from '@/components/files/FileIcons'
import { basenameOf, dirnameOf, isInside, joinPath, validName } from '@/components/files/path-util'
import { isExternalFileDrag } from '@/components/terminal/file-paste'
import { useConnectionStore } from '@/stores/connection'
import { useFilesStore } from '@/stores/files'
import { useUiStore } from '@/stores/ui'

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

/** How often an open tree re-lists itself and re-reads git status. */
const POLL_MS = 4000
/** VS Code's gitDecoration colours, applied to the name and the badge letter. */
const MODIFIED_COLOR = 'var(--ra-git-modified)'
const STAGED_COLOR = 'var(--ra-git-added)'
const UNTRACKED_COLOR = 'var(--ra-git-untracked)'

const isMac = navigator.platform.startsWith('Mac')

function isDirLike(e: TreeEntry): boolean {
  return e.type === 'dir' || (e.type === 'symlink' && e.linkTargetType === 'dir')
}

/**
 * Do two listings describe the same directory? Compared field by field so a
 * background poll only re-renders when something actually changed on disk.
 */
function sameEntries(a: TreeEntry[] | undefined, b: TreeEntry[]): boolean {
  if (a === undefined || a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (
      x.name !== y.name ||
      x.type !== y.type ||
      x.size !== y.size ||
      x.mtime !== y.mtime ||
      x.mode !== y.mode ||
      x.linkTargetType !== y.linkTargetType
    ) {
      return false
    }
  }
  return true
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

interface MenuTarget {
  x: number
  y: number
  /** null for the tree's root row */
  entry: TreeEntry | null
}

/** An open name prompt: what to ask, and what to do with the answer. */
interface PromptState extends PromptSpec {
  onSubmit(value: string): void
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
  const [menu, setMenu] = useState<MenuTarget | null>(null)
  const [prompt, setPrompt] = useState<PromptState | null>(null)
  const [dragOver, setDragOver] = useState<string | null>(null)
  /** highlighted row: the last one clicked, or the file the viewer is showing */
  const [selected, setSelected] = useState<string | null>(null)
  const openFile = useFilesStore((s) => s.openFile)
  const activeFile = useFilesStore((s) => s.activeBySession[sessionId] ?? null)
  const addToast = useUiStore((s) => s.addToast)
  const mounted = useRef(true)
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const draggingRef = useRef<TreeEntry | null>(null)
  /** guards against overlapping refreshes when the server is slow */
  const refreshingRef = useRef(false)

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

  /**
   * Reload every expanded directory in a single helper call. Doing this as N
   * parallel `ls-tree` execs opens N ssh channels at once, which the server
   * refuses once its MaxSessions budget is spent on attached terminals.
   */
  const reloadDirs = useCallback(
    async (
      targets: string[],
      /** `silent` skips the loading state; `fromPoll` may be dropped entirely */
      opts: { silent: boolean; fromPoll?: boolean }
    ): Promise<void> => {
      if (targets.length === 0) return
      // only a background tick yields; a refresh the user (or an edit) asked
      // for must not be dropped because a tick is in flight
      if (opts.fromPoll === true && refreshingRef.current) return
      refreshingRef.current = true
      if (!opts.silent) {
        setNodes((n) => {
          const next = { ...n }
          for (const p of targets) {
            next[p] = { ...(next[p] ?? { expanded: true }), loading: true, error: undefined }
          }
          return next
        })
      }
      try {
        const trees = await api.fsLsTrees(hostId, targets)
        if (!mounted.current) return
        setNodes((n) => {
          let changed = false
          const next = { ...n }
          for (const tree of trees) {
            const prev = next[tree.path]
            if (tree.entries === undefined) {
              // a directory that vanished under us: surface it, keep the rest
              if (prev?.error !== tree.error?.message || prev?.loading === true) {
                next[tree.path] = {
                  ...(prev ?? { expanded: true }),
                  loading: false,
                  ...(tree.error ? { error: tree.error.message } : {})
                }
                changed = true
              }
              continue
            }
            const entries = sortEntries(tree.entries)
            // skip the state update when nothing moved, so a background poll
            // never re-renders (or re-scrolls) the tree for free
            if (prev?.loading !== true && prev?.error === undefined && sameEntries(prev?.entries, entries)) {
              continue
            }
            next[tree.path] = {
              ...(prev ?? { expanded: true }),
              entries,
              loading: false,
              error: undefined
            }
            changed = true
          }
          return changed ? next : n
        })
      } catch (err) {
        if (!mounted.current || opts.fromPoll === true) return // the next tick retries
        setNodes((n) => {
          const next = { ...n }
          for (const p of targets) {
            next[p] = { ...(next[p] ?? { expanded: true }), loading: false, error: errText(err) }
          }
          return next
        })
      } finally {
        refreshingRef.current = false
      }
    },
    [hostId]
  )

  /** Every directory currently expanded (the root when none is). */
  const expandedDirs = useCallback((): string[] => {
    const expanded = Object.entries(nodesRef.current)
      .filter(([, v]) => v.expanded)
      .map(([k]) => k)
    return expanded.length > 0 ? expanded : [rootPath]
  }, [rootPath])

  const refreshExpanded = useCallback(
    (opts: { silent: boolean; fromPoll?: boolean }): Promise<void> =>
      reloadDirs(expandedDirs(), opts),
    [expandedDirs, reloadDirs]
  )

  const refreshAll = useCallback(async (): Promise<void> => {
    void refreshGit()
    await refreshExpanded({ silent: false })
  }, [refreshGit, refreshExpanded])

  // root load (and reset when the root changes)
  useEffect(() => {
    setNodes({})
    setSelected(null)
    void loadDir(rootPath)
  }, [rootPath, loadDir])

  // follow the viewer: switching file tabs highlights that file in the tree
  useEffect(() => {
    if (activeFile !== null) setSelected(activeFile)
  }, [activeFile])

  /*
   * Semi-live tree: while the window is visible, re-list the expanded
   * directories and re-read git status on one tick. The listing is a single
   * batched helper call and only touches React state when the directory
   * actually changed, so an idle tree costs two execs every few seconds and
   * renders nothing. Hidden windows (and dockview-hidden panels, which are
   * unmounted) poll not at all.
   */
  useEffect(() => {
    void refreshGit()
    const iv = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void refreshGit()
      void refreshExpanded({ silent: true, fromPoll: true })
    }, POLL_MS)
    return () => window.clearInterval(iv)
  }, [refreshGit, refreshExpanded])

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
    for (const p of git.modified) add(p, 'M', MODIFIED_COLOR)
    for (const p of git.staged) add(p, 'A', STAGED_COLOR)
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

  // ---------------- file operations ----------------

  /** Reload the directories a change touched (and git status with them). */
  const refreshDirs = useCallback(
    async (dirs: string[]): Promise<void> => {
      void refreshGit()
      const loaded = new Set(Object.keys(nodesRef.current))
      await reloadDirs([...new Set(dirs)].filter((d) => loaded.has(d)), { silent: true })
    },
    [refreshGit, reloadDirs]
  )

  /** Expand a directory and reload it, so a new child shows up right away. */
  const expandAndRefresh = useCallback(
    async (dir: string): Promise<void> => {
      void refreshGit()
      await loadDir(dir)
    },
    [loadDir, refreshGit]
  )

  /**
   * Move/rename on the server, then follow the file in the UI: an open
   * viewer tab for the old path is reopened at the new one.
   */
  const moveEntry = useCallback(
    async (entry: TreeEntry, dest: string): Promise<void> => {
      if (dest === entry.path) return
      const dir = isDirLike(entry)
      if (dir && isInside(entry.path, dest)) {
        addToast('error', 'Cannot move a folder into itself')
        return
      }
      try {
        const moved = await api.fsMove(hostId, entry.path, dest)
        const files = useFilesStore.getState()
        const open = files.openBySession[sessionId] ?? []
        for (const p of open) {
          if (p === entry.path) {
            files.closeFile(sessionId, p)
            files.openFile(sessionId, moved)
          } else if (dir && isInside(entry.path, p)) {
            // the viewer cannot follow every child; close them instead
            files.closeFile(sessionId, p)
          }
        }
        addToast('success', `Moved to ${moved}`)
        await refreshDirs([dirnameOf(entry.path), dirnameOf(moved)])
      } catch (err) {
        addToast('error', `Move failed: ${errText(err)}`)
      }
    },
    [addToast, hostId, refreshDirs, sessionId]
  )

  /** Names already present in a directory, for the prompts' clash check. */
  const siblingNames = useCallback(
    (dir: string): string[] => (nodesRef.current[dir]?.entries ?? []).map((e) => e.name),
    []
  )

  const renameEntry = useCallback(
    (entry: TreeEntry): void => {
      const dir = dirnameOf(entry.path)
      setPrompt({
        ...renameSpec(entry.path, siblingNames(dir).filter((n) => n !== entry.name)),
        onSubmit: (value) => {
          const name = validName(value)
          if (name === null || name === entry.name) return
          void moveEntry(entry, joinPath(dir, name))
        }
      })
    },
    [moveEntry, siblingNames]
  )

  const moveEntryTo = useCallback(
    (entry: TreeEntry): void => {
      setPrompt({
        ...moveSpec(entry.path),
        onSubmit: (value) => {
          const dest = value.trim()
          if (dest === '' || dest === entry.path) return
          void moveEntry(entry, dest)
        }
      })
    },
    [moveEntry]
  )

  const deleteEntry = useCallback(
    (entry: TreeEntry): void => {
      const dir = isDirLike(entry) && entry.type !== 'symlink'
      const question = dir
        ? `Delete the folder “${entry.name}” and everything in it?\n${entry.path}`
        : `Delete “${entry.name}”?\n${entry.path}`
      if (!window.confirm(question)) return
      void (async () => {
        try {
          await api.fsDelete(hostId, entry.path, dir)
          const files = useFilesStore.getState()
          for (const p of files.openBySession[sessionId] ?? []) {
            if (p === entry.path || (dir && isInside(entry.path, p))) {
              files.closeFile(sessionId, p)
            }
          }
          addToast('success', `Deleted ${entry.name}`)
          await refreshDirs([dirnameOf(entry.path)])
        } catch (err) {
          addToast('error', `Delete failed: ${errText(err)}`)
        }
      })()
    },
    [addToast, hostId, refreshDirs, sessionId]
  )

  /** Parent directory new items go into: the folder itself, or its parent. */
  const targetDir = useCallback(
    (entry: TreeEntry | null): string => {
      if (entry === null) return rootPath
      return isDirLike(entry) ? entry.path : dirnameOf(entry.path)
    },
    [rootPath]
  )

  const createFile = useCallback(
    (entry: TreeEntry | null): void => {
      const dir = targetDir(entry)
      setPrompt({
        ...newFileSpec(dir, siblingNames(dir)),
        onSubmit: (value) => {
          const name = validName(value)
          if (name === null) return
          void (async () => {
            const path = joinPath(dir, name)
            try {
              // fsWrite replaces atomically, so an existing file would be
              // clobbered silently — check the server, not just the cache
              const existing = await api.fsLsTree(hostId, dir)
              if (existing.some((e) => e.name === name)) {
                addToast('error', `${name} already exists`)
                return
              }
              await api.fsWrite(hostId, path, new Uint8Array())
              await expandAndRefresh(dir)
              openFile(sessionId, path)
            } catch (err) {
              addToast('error', `Could not create file: ${errText(err)}`)
            }
          })()
        }
      })
    },
    [addToast, expandAndRefresh, hostId, openFile, sessionId, siblingNames, targetDir]
  )

  const createFolder = useCallback(
    (entry: TreeEntry | null): void => {
      const dir = targetDir(entry)
      setPrompt({
        ...newFolderSpec(dir, siblingNames(dir)),
        onSubmit: (value) => {
          const name = validName(value)
          if (name === null) return
          void (async () => {
            try {
              await api.fsMkdir(hostId, joinPath(dir, name))
              await expandAndRefresh(dir)
            } catch (err) {
              addToast('error', `Could not create folder: ${errText(err)}`)
            }
          })()
        }
      })
    },
    [addToast, expandAndRefresh, hostId, siblingNames, targetDir]
  )

  // ---------------- uploads from this computer ----------------

  /** Copy local files into `dir` on the host, then show them there. */
  const uploadInto = useCallback(
    (dir: string, run: () => Promise<string[] | null>): void => {
      void (async () => {
        // a quick paste needs no toast; a big folder should say it is working
        const slow = window.setTimeout(() => addToast('info', 'Uploading…'), 600)
        try {
          const uploaded = await run()
          if (uploaded === null) {
            addToast('info', 'Nothing to paste — copy files in Finder, or an image, first')
            return
          }
          if (uploaded.length === 0) return
          await expandAndRefresh(dir)
          setSelected(uploaded[uploaded.length - 1])
          addToast(
            'success',
            uploaded.length === 1
              ? `Uploaded ${basenameOf(uploaded[0])}`
              : `Uploaded ${uploaded.length} items to ${basenameOf(dir) || dir}`
          )
        } catch (err) {
          addToast('error', `Upload failed: ${errText(err)}`)
        } finally {
          window.clearTimeout(slow)
        }
      })()
    },
    [addToast, expandAndRefresh]
  )

  /** The open entry for a path, from the listing of its parent. */
  const entryAt = useCallback(
    (path: string | null): TreeEntry | null => {
      if (path === null || path === rootPath) return null
      return nodesRef.current[dirnameOf(path)]?.entries?.find((e) => e.path === path) ?? null
    },
    [rootPath]
  )

  const pasteFromClipboard = useCallback(
    (entry: TreeEntry | null): void => {
      const dir = targetDir(entry)
      uploadInto(dir, () => api.fsUploadClipboard(hostId, dir))
    },
    [hostId, targetDir, uploadInto]
  )

  const copyPath = useCallback(
    (path: string): void => {
      void navigator.clipboard
        .writeText(path)
        .then(() => addToast('success', 'Path copied'))
        .catch(() => addToast('error', 'Could not copy the path'))
    },
    [addToast]
  )

  const menuEntries = useCallback(
    (target: MenuTarget): MenuEntry[] => {
      const entry = target.entry
      const dir = entry !== null && isDirLike(entry)
      const items: MenuEntry[] = []
      if (entry !== null && !dir) {
        items.push({
          kind: 'item',
          icon: '↗',
          label: 'Open',
          title: 'Open in this session’s viewer',
          onClick: () => openFile(sessionId, entry.path)
        })
        items.push({ kind: 'separator' })
      }
      items.push({
        kind: 'item',
        icon: '＋',
        label: 'New file…',
        onClick: () => createFile(entry)
      })
      items.push({
        kind: 'item',
        icon: '＋',
        label: 'New folder…',
        onClick: () => createFolder(entry)
      })
      items.push({
        kind: 'item',
        icon: '⇣',
        label: `Paste from computer${isMac ? '  ⌘V' : '  Ctrl+V'}`,
        title: 'Upload files copied in Finder, or a copied image, into this folder',
        onClick: () => pasteFromClipboard(entry)
      })
      if (entry !== null) {
        items.push({ kind: 'separator' })
        items.push({
          kind: 'item',
          icon: '✎',
          label: 'Rename…',
          onClick: () => renameEntry(entry)
        })
        items.push({
          kind: 'item',
          icon: '⇄',
          label: 'Move…',
          title: 'Move to another directory on the server',
          onClick: () => moveEntryTo(entry)
        })
      }
      items.push({ kind: 'separator' })
      items.push({
        kind: 'item',
        icon: '⧉',
        label: 'Copy path',
        onClick: () => copyPath(entry?.path ?? rootPath)
      })
      items.push({
        kind: 'item',
        icon: '↻',
        label: 'Refresh',
        onClick: () => void refreshAll()
      })
      if (entry !== null) {
        items.push({ kind: 'separator' })
        items.push({
          kind: 'item',
          icon: '🗑',
          label: dir ? 'Delete folder…' : 'Delete…',
          danger: true,
          onClick: () => deleteEntry(entry)
        })
      }
      return items
    },
    [
      copyPath,
      createFile,
      createFolder,
      deleteEntry,
      moveEntryTo,
      openFile,
      pasteFromClipboard,
      refreshAll,
      renameEntry,
      rootPath,
      sessionId
    ]
  )

  // ---------------- drag to move ----------------

  const onDropInto = (dirPath: string): void => {
    const dragged = draggingRef.current
    draggingRef.current = null
    setDragOver(null)
    if (!dragged) return
    if (dirnameOf(dragged.path) === dirPath.replace(/\/+$/, '')) return // already there
    if (isDirLike(dragged) && isInside(dragged.path, dirPath)) {
      addToast('error', 'Cannot move a folder into itself')
      return
    }
    void moveEntry(dragged, joinPath(dirPath, dragged.name))
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
                className={`ra-tree-row${selected === entry.path ? ' ra-selected' : ''}${
                  dragOver === entry.path ? ' ra-drop-target' : ''
                }`}
                onClick={() => {
                  setSelected(entry.path)
                  if (dir) toggleDir(entry.path)
                  else openFile(sessionId, entry.path)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setSelected(entry.path)
                  setMenu({ x: e.clientX, y: e.clientY, entry })
                }}
                draggable
                onDragStart={(e) => {
                  draggingRef.current = entry
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', entry.path)
                }}
                onDragEnd={() => {
                  draggingRef.current = null
                  setDragOver(null)
                }}
                onDragOver={(e) => {
                  const dragged = draggingRef.current
                  if (!dragged) {
                    // files from this computer: a folder takes them, a file
                    // row hands them to the folder it sits in
                    if (!isExternalFileDrag(Array.from(e.dataTransfer.types))) return
                    e.preventDefault()
                    e.stopPropagation()
                    e.dataTransfer.dropEffect = 'copy'
                    const into = dir ? entry.path : dirnameOf(entry.path)
                    if (dragOver !== into) setDragOver(into)
                    return
                  }
                  if (!dir || dragged.path === entry.path) return
                  e.preventDefault()
                  e.stopPropagation()
                  e.dataTransfer.dropEffect = 'move'
                  if (dragOver !== entry.path) setDragOver(entry.path)
                }}
                onDrop={(e) => {
                  if (!draggingRef.current) {
                    const files = Array.from(e.dataTransfer.files)
                    if (files.length === 0) return
                    e.preventDefault()
                    e.stopPropagation()
                    setDragOver(null)
                    const into = dir ? entry.path : dirnameOf(entry.path)
                    uploadInto(into, () => api.fsUploadFiles(hostId, files, into))
                    return
                  }
                  if (!dir) return
                  e.preventDefault()
                  e.stopPropagation()
                  onDropInto(entry.path)
                }}
                title={entry.path}
                style={{
                  padding: `1px 8px 1px ${pad}px`,
                  color: dir ? 'var(--ra-text)' : 'var(--ra-text-dim)'
                }}
              >
                <span
                  style={{
                    width: 10,
                    flexShrink: 0,
                    display: 'flex',
                    justifyContent: 'center',
                    color: 'var(--ra-text-faint)'
                  }}
                >
                  {dir && <ChevronIcon open={child?.expanded === true} />}
                </span>
                <span style={{ position: 'relative', flexShrink: 0, display: 'flex' }}>
                  {dir ? (
                    <FolderIcon
                      open={child?.expanded === true}
                      color={
                        selected === entry.path
                          ? 'var(--ra-selected-text)'
                          : 'var(--ra-text-dim)'
                      }
                    />
                  ) : (
                    <FileIcon color={fileIconColor(entry.name)} />
                  )}
                  {entry.type === 'symlink' && <SymlinkBadge />}
                </span>
                <span
                  className='ra-tree-name'
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
                    title='Contains changes'
                    style={{
                      flexShrink: 0,
                      marginLeft: 'auto',
                      paddingRight: 4,
                      fontSize: 9,
                      color: MODIFIED_COLOR
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
    // the tree sits on the darker "side" surface, like VS Code's explorer
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--ra-bg-side)'
      }}
    >
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 8px',
          borderBottom: '1px solid var(--ra-border)',
          background: 'var(--ra-bg-side)'
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
      <div
        style={{
          flex: 1,
          overflow: 'auto',
          padding: '4px 0',
          outline: 'none',
          background: dragOver === rootPath ? 'var(--ra-accent-dim)' : undefined
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY, entry: null })
        }}
        tabIndex={0}
        onKeyDown={(e) => {
          // ⌘V (Ctrl+V) with the tree focused uploads what was copied locally
          const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
          if (!mod || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'v') return
          e.preventDefault()
          pasteFromClipboard(entryAt(selected))
        }}
        onDragOver={(e) => {
          const external = !draggingRef.current
          if (external && !isExternalFileDrag(Array.from(e.dataTransfer.types))) return
          e.preventDefault()
          e.dataTransfer.dropEffect = external ? 'copy' : 'move'
          if (dragOver !== rootPath) setDragOver(rootPath)
        }}
        onDragLeave={(e) => {
          // leaving for a child row is not leaving the tree
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(null)
        }}
        onDrop={(e) => {
          e.preventDefault()
          if (!draggingRef.current) {
            setDragOver(null)
            const files = Array.from(e.dataTransfer.files)
            if (files.length > 0) uploadInto(rootPath, () => api.fsUploadFiles(hostId, files, rootPath))
            return
          }
          onDropInto(rootPath)
        }}
      >
        {renderChildren(rootPath, 0)}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={menuEntries(menu).map((entry) =>
            entry.kind === 'item'
              ? {
                  ...entry,
                  onClick: () => {
                    setMenu(null)
                    entry.onClick()
                  }
                }
              : entry
          )}
          onDismiss={() => setMenu(null)}
        />
      )}
      {prompt && (
        <PromptDialog
          title={prompt.title}
          label={prompt.label}
          initialValue={prompt.initialValue}
          confirmLabel={prompt.confirmLabel}
          {...(prompt.placeholder !== undefined ? { placeholder: prompt.placeholder } : {})}
          {...(prompt.selectTo !== undefined ? { selectTo: prompt.selectTo } : {})}
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
