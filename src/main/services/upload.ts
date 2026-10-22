/**
 * Local -> host uploads: files dropped or pasted into the file tree, and the
 * ones handed to an agent in the terminal (staged under ~/.remote-agent).
 * Local paths only ever come from the main process itself (the clipboard) or
 * from the preload, which derives them from real dropped File objects — the
 * page cannot name an arbitrary local file to send.
 */
import { randomBytes } from 'crypto'
import { lstat, readdir, stat } from 'fs/promises'
import { basename, join, posix } from 'path'
import { getSftpService } from '../ssh/sftp-service'
import { CodedError } from '../util/errors'
import {
  UPLOAD_MAX_BYTES,
  UPLOAD_MAX_FILES,
  UPLOAD_STAGING_ROOT,
  safeEntryName,
  stagingDirName,
  uniqueName
} from './upload-util'

interface PlanEntry {
  local: string
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

function tooBig(what: string): CodedError {
  return new CodedError(
    'too-large',
    `${what} — uploads are limited to ${UPLOAD_MAX_FILES} files and ${UPLOAD_MAX_BYTES / 1024 ** 3} GiB at a time`
  )
}

/**
 * Everything to copy, depth first so a folder always precedes its contents.
 * Symlinks inside folders are skipped (they could loop or point anywhere); a
 * symlink dropped at the top level is followed, as Finder would.
 */
async function plan(paths: string[]): Promise<{ items: PlanItem[]; files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const count = (size: number): void => {
    files++
    bytes += size
    if (files > UPLOAD_MAX_FILES) throw tooBig(`More than ${UPLOAD_MAX_FILES} files`)
    if (bytes > UPLOAD_MAX_BYTES) throw tooBig('More than 2 GiB')
  }

  const walk = async (local: string, rel: string, out: PlanEntry[]): Promise<void> => {
    for (const name of (await readdir(local)).sort()) {
      const child = join(local, name)
      const st = await lstat(child)
      const childRel = rel === '' ? name : `${rel}/${name}`
      if (st.isDirectory()) {
        out.push({ local: child, rel: childRel, isDir: true, size: 0, mode: DIR_MODE })
        await walk(child, childRel, out)
      } else if (st.isFile()) {
        count(st.size)
        out.push({ local: child, rel: childRel, isDir: false, size: st.size, mode: st.mode & 0o777 })
      }
    }
  }

  const items: PlanItem[] = []
  for (const path of paths) {
    const name = safeEntryName(basename(path))
    if (name === null) continue
    let st
    try {
      st = await stat(path)
    } catch {
      throw new CodedError('not-found', `cannot read ${path}`)
    }
    const entries: PlanEntry[] = []
    if (st.isDirectory()) {
      entries.push({ local: path, rel: '', isDir: true, size: 0, mode: DIR_MODE })
      await walk(path, '', entries)
    } else if (st.isFile()) {
      count(st.size)
      entries.push({ local: path, rel: '', isDir: false, size: st.size, mode: st.mode & 0o777 })
    } else {
      continue // sockets, devices, …
    }
    items.push({ name, entries })
  }
  return { items, files, bytes }
}

/** Absolute host directory to upload into: `remoteDir`, or a fresh staging dir. */
async function targetDir(hostId: string, remoteDir: string | null): Promise<string> {
  const sftp = getSftpService(hostId)
  if (remoteDir !== null) {
    const st = await sftp.stat(remoteDir)
    if (!st?.isDir) throw new CodedError('not-found', `no such directory: ${remoteDir}`)
    return remoteDir
  }
  const home = await sftp.homeDir()
  const dir = posix.join(
    home,
    UPLOAD_STAGING_ROOT.replace(/^~\//, ''),
    stagingDirName(new Date(), randomBytes(3).toString('hex'))
  )
  await sftp.mkdirp(dir)
  return dir
}

/** Names already in `dir`, so uploads never replace an existing entry. */
async function takenNames(hostId: string, dir: string): Promise<Set<string>> {
  return new Set((await getSftpService(hostId).readdir(dir)).map((e) => e.name))
}

/**
 * Copy local files/folders into `remoteDir` (or a staging dir when null).
 * Resolves with the host path of each top-level item, in order.
 */
export async function uploadLocalPaths(
  hostId: string,
  localPaths: string[],
  remoteDir: string | null
): Promise<string[]> {
  const { items } = await plan(localPaths)
  if (items.length === 0) return []
  const dir = await targetDir(hostId, remoteDir)
  const taken = await takenNames(hostId, dir)
  const sftp = getSftpService(hostId)
  const out: string[] = []
  for (const item of items) {
    const name = uniqueName(item.name, taken)
    taken.add(name)
    const top = posix.join(dir, name)
    for (const e of item.entries) {
      const remote = e.rel === '' ? top : posix.join(top, e.rel)
      if (e.isDir) await sftp.mkdirp(remote)
      else await sftp.uploadFile(e.local, remote, e.size, e.mode)
    }
    out.push(top)
  }
  return out
}

/** Write in-memory bytes (a pasted image) as a new file; resolves with its path. */
export async function uploadBytes(
  hostId: string,
  name: string,
  data: Buffer,
  remoteDir: string | null
): Promise<string> {
  const dir = await targetDir(hostId, remoteDir)
  const unique = uniqueName(name, await takenNames(hostId, dir))
  const path = posix.join(dir, unique)
  await getSftpService(hostId).writeFileAtomic(path, data, 0o644)
  return path
}
