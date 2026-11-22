/**
 * Host -> this computer: files copied in the tree (pasted in Finder with ⌘V)
 * and files dragged out of the tree onto Finder or the desktop.
 *
 * Copies are downloaded whole into a per-copy dir under the OS temp dir and
 * their paths put on the clipboard. Drags cannot wait for a download, so a
 * dragged file carries a link to a loopback HTTP server instead; the OS only
 * fetches it once the drag is dropped somewhere that takes files.
 */
import { app } from 'electron'
import { randomBytes } from 'crypto'
import { createReadStream } from 'fs'
import { chmod, mkdir, readdir, rm, stat as statLocal } from 'fs/promises'
import { createServer } from 'http'
import type { Server, ServerResponse } from 'http'
import { join, posix } from 'path'
import { getSftpService } from '../ssh/sftp-service'
import { CodedError } from '../util/errors'
import {
  DRAG_LINK_TTL_MS,
  LOCAL_STAGING_MAX_AGE_MS,
  contentDisposition,
  downloadUrlData,
  localFileMode
} from './download-util'
import { tooBig } from './upload'
import { UPLOAD_MAX_BYTES, UPLOAD_MAX_FILES, safeEntryName, stagingDirName, uniqueName } from './upload-util'

interface PlanEntry {
  remote: string
  /** path under the top-level item, e.g. "" for the item itself, "src/a.ts" */
  rel: string
  isDir: boolean
  size: number
  mode: number
}

interface PlanItem {
  name: string
  entries: PlanEntry[]
}

const DIR_MODE = 0o755

function stagingRoot(): string {
  return join(app.getPath('temp'), 'remote-agent-downloads')
}

/**
 * Everything to copy, depth first so a folder precedes its contents. Same
 * rules as uploads: symlinks inside folders are skipped, a top-level one is
 * followed, and nothing past the file/byte limits is fetched at all.
 */
async function plan(hostId: string, paths: string[]): Promise<PlanItem[]> {
  const sftp = getSftpService(hostId)
  let files = 0
  let bytes = 0
  const count = (size: number): void => {
    files++
    bytes += size
    if (files > UPLOAD_MAX_FILES) throw tooBig(`More than ${UPLOAD_MAX_FILES} files`)
    if (bytes > UPLOAD_MAX_BYTES) throw tooBig('More than 2 GiB')
  }

  const walk = async (remote: string, rel: string, out: PlanEntry[]): Promise<void> => {
    const list = await sftp.readdir(remote)
    list.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of list) {
      // also drops "." and "..", and anything that is not a plain name here
      if (safeEntryName(e.name) !== e.name) continue
      const child = posix.join(remote, e.name)
      const childRel = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.kind === 'dir') {
        out.push({ remote: child, rel: childRel, isDir: true, size: 0, mode: DIR_MODE })
        await walk(child, childRel, out)
      } else if (e.kind === 'file') {
        count(e.size)
        out.push({ remote: child, rel: childRel, isDir: false, size: e.size, mode: e.mode })
      }
    }
  }

  const items: PlanItem[] = []
  for (const path of paths) {
    const name = safeEntryName(posix.basename(path))
    if (name === null) continue
    const st = await sftp.stat(path)
    if (st === null) throw new CodedError('not-found', `no such file: ${path}`)
    const entries: PlanEntry[] = []
    if (st.isDir) {
      entries.push({ remote: path, rel: '', isDir: true, size: 0, mode: DIR_MODE })
      await walk(path, '', entries)
    } else if (st.isFile) {
      count(st.size)
      entries.push({ remote: path, rel: '', isDir: false, size: st.size, mode: st.mode })
    } else {
      continue // sockets, devices, …
    }
    items.push({ name, entries })
  }
  return items
}

/** Remove local copies from earlier sessions; Finder has long since copied them. */
export async function pruneLocalStaging(now = Date.now()): Promise<void> {
  const root = stagingRoot()
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return // nothing staged yet
  }
  for (const name of names) {
    const path = join(root, name)
    try {
      const st = await statLocal(path)
      if (now - st.mtimeMs > LOCAL_STAGING_MAX_AGE_MS) await rm(path, { recursive: true, force: true })
    } catch {
      // raced with another sweep, or unreadable: leave it
    }
  }
}

/**
 * Download host files/folders into a fresh local dir. Resolves with the
 * local path of each top-level item, in order; a failure leaves nothing.
 */
export async function downloadRemotePaths(hostId: string, remotePaths: string[]): Promise<string[]> {
  const items = await plan(hostId, remotePaths)
  if (items.length === 0) return []
  void pruneLocalStaging()
  const dir = join(stagingRoot(), stagingDirName(new Date(), randomBytes(3).toString('hex')))
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const sftp = getSftpService(hostId)
  const taken = new Set<string>()
  const out: string[] = []
  try {
    for (const item of items) {
      const name = uniqueName(item.name, taken)
      taken.add(name)
      const top = join(dir, name)
      for (const e of item.entries) {
        const local = e.rel === '' ? top : join(top, ...e.rel.split('/'))
        if (e.isDir) {
          await mkdir(local, { recursive: true, mode: DIR_MODE })
        } else {
          await sftp.downloadFile(e.remote, local, e.size)
          await chmod(local, localFileMode(e.mode))
        }
      }
      out.push(top)
    }
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    throw err
  }
  return out
}

// ---------------- drag-out links ----------------

interface DragLink {
  hostId: string
  path: string
  expires: number
}

const links = new Map<string, DragLink>()
let server: Server | null = null
let port = 0

/** Fetch one dragged file from the host and stream it to the OS. */
async function serveLink(link: DragLink, res: ServerResponse): Promise<void> {
  const sftp = getSftpService(link.hostId)
  const st = await sftp.stat(link.path)
  if (st === null || !st.isFile) {
    res.writeHead(404).end()
    return
  }
  if (st.size > UPLOAD_MAX_BYTES) {
    res.writeHead(413).end()
    return
  }
  const root = stagingRoot()
  await mkdir(root, { recursive: true, mode: 0o700 })
  const tmp = join(root, 'drag-' + randomBytes(6).toString('hex'))
  try {
    await sftp.downloadFile(link.path, tmp, st.size)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
  const name = posix.basename(link.path)
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(st.size),
    'Content-Disposition': contentDisposition(name),
    'Cache-Control': 'no-store'
  })
  const stream = createReadStream(tmp)
  const cleanup = (): void => void rm(tmp, { force: true }).catch(() => undefined)
  stream.on('error', () => res.destroy())
  res.on('close', cleanup)
  stream.pipe(res)
}

/** Start the loopback server drag-out links point at. Idempotent. */
export function startDragServer(): void {
  if (server !== null) return
  const srv = createServer((req, res) => {
    // only our own links: a random 128-bit token per dragged file
    const token = (req.url ?? '').replace(/^\/+/, '').split(/[/?#]/)[0]
    const link = links.get(token)
    if (req.method !== 'GET' || link === undefined || link.expires < Date.now()) {
      res.writeHead(404).end()
      return
    }
    serveLink(link, res).catch(() => {
      if (!res.headersSent) res.writeHead(502).end()
      else res.destroy()
    })
  })
  srv.on('error', () => {
    // drag-out simply stays unavailable; copy/paste still works
    if (server === srv) server = null
  })
  srv.listen(0, '127.0.0.1', () => {
    const addr = srv.address()
    if (addr !== null && typeof addr === 'object') port = addr.port
  })
  server = srv
}

/**
 * `DownloadURL` drag data for a host file, or null when drag-out is not
 * available. Called synchronously from the renderer's dragstart, so it only
 * mints a link; nothing is fetched unless the drag ends on Finder.
 */
export function dragOutData(hostId: string, path: string): string | null {
  const name = safeEntryName(posix.basename(path))
  if (name === null || server === null || port === 0) return null
  const now = Date.now()
  for (const [t, l] of links) if (l.expires < now) links.delete(t)
  const token = randomBytes(16).toString('hex')
  links.set(token, { hostId, path, expires: now + DRAG_LINK_TTL_MS })
  return downloadUrlData(name, `http://127.0.0.1:${port}/${token}`)
}
