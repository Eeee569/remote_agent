/**
 * Per-host SFTP access. Lazily opens ONE sftp channel via the connection
 * manager's client and transparently re-opens it after reconnects. All
 * operations are serialized through a promise queue with a per-op timeout.
 */
import type { SFTPWrapper } from 'ssh2'
import { randomBytes } from 'crypto'
import { getConnectionManager } from './connection-manager'
import { CodedError } from '../util/errors'

const OP_TIMEOUT_MS = 30_000
const READ_CAP_BYTES = 2 * 1024 * 1024 // 2 MiB
const IO_CHUNK = 32_768

const S_IFMT = 0o170000
const S_IFDIR = 0o040000

// SFTP status codes (SSH_FXP_STATUS)
const SFX_EOF = 1
const SFX_NO_SUCH_FILE = 2

interface SftpErrorLike extends Error {
  code?: number | string
}

function isNoSuchFile(err: unknown): boolean {
  const e = err as SftpErrorLike
  return e?.code === SFX_NO_SUCH_FILE || /no such file/i.test(e?.message ?? '')
}

function toSftpError(err: unknown, label: string): CodedError {
  if (err instanceof CodedError) return err
  const msg = err instanceof Error ? err.message : String(err)
  return new CodedError('sftp-failed', `sftp ${label} failed: ${msg}`)
}

// ---------------- promisified sftp primitives ----------------

function sfOpen(sftp: SFTPWrapper, path: string, mode: 'r' | 'w'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(path, mode, (err, handle) => (err ? reject(err) : resolve(handle)))
  })
}

function sfClose(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.close(handle, (err) => (err ? reject(err) : resolve()))
  })
}

function sfFstat(sftp: SFTPWrapper, handle: Buffer): Promise<{ size: number; mtime: number }> {
  return new Promise((resolve, reject) => {
    sftp.fstat(handle, (err, stats) => (err ? reject(err) : resolve(stats)))
  })
}

function sfRead(
  sftp: SFTPWrapper,
  handle: Buffer,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    sftp.read(handle, buffer, offset, length, position, (err, bytesRead) => {
      if (err) {
        if ((err as SftpErrorLike).code === SFX_EOF) resolve(0)
        else reject(err)
      } else {
        resolve(bytesRead)
      }
    })
  })
}

function sfWrite(
  sftp: SFTPWrapper,
  handle: Buffer,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.write(handle, buffer, offset, length, position, (err) => (err ? reject(err) : resolve()))
  })
}

function sfChmod(sftp: SFTPWrapper, path: string, mode: number): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.chmod(path, mode, (err) => (err ? reject(err) : resolve()))
  })
}

function sfRename(sftp: SFTPWrapper, src: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(src, dest, (err) => (err ? reject(err) : resolve()))
  })
}

/** POSIX rename (overwrites the target); throws synchronously when unsupported. */
function sfPosixRename(sftp: SFTPWrapper, src: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      sftp.ext_openssh_rename(src, dest, (err) => (err ? reject(err) : resolve()))
    } catch (err) {
      reject(err)
    }
  })
}

function sfUnlink(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (err) => (err ? reject(err) : resolve()))
  })
}

function sfMkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => (err ? reject(err) : resolve()))
  })
}

function sfStat(
  sftp: SFTPWrapper,
  path: string
): Promise<{ size: number; mtime: number; mode: number; isDirectory(): boolean }> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, stats) => (err ? reject(err) : resolve(stats)))
  })
}

function sfReaddir(
  sftp: SFTPWrapper,
  path: string
): Promise<Array<{ filename: string; attrs: { mode: number } }>> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list)))
  })
}

function sfRealpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    sftp.realpath(path, (err, abs) => (err ? reject(err) : resolve(abs)))
  })
}

// ---------------- service ----------------

export class SftpService {
  private sftp: SFTPWrapper | null = null
  private opening: Promise<SFTPWrapper> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private home: string | null = null

  constructor(private readonly hostId: string) {
    getConnectionManager().onStatus((e) => {
      if (e.hostId === this.hostId && e.status !== 'connected') {
        // the channel is dead (or about to be); force a re-open on next use
        this.sftp = null
      }
    })
  }

  async readFile(
    path: string,
    maxBytes?: number
  ): Promise<{ data: Buffer; truncated: boolean; size: number; mtimeMs: number }> {
    const cap = maxBytes ?? READ_CAP_BYTES
    return this.run('readFile', async (sftp) => {
      const abs = await this.expand(sftp, path)
      let handle: Buffer
      try {
        handle = await sfOpen(sftp, abs, 'r')
      } catch (err) {
        if (isNoSuchFile(err)) throw new CodedError('not-found', `no such file: ${abs}`)
        throw err
      }
      try {
        const st = await sfFstat(sftp, handle)
        const toRead = Math.min(st.size, cap)
        const data = Buffer.alloc(toRead)
        let offset = 0
        while (offset < toRead) {
          const n = await sfRead(sftp, handle, data, offset, toRead - offset, offset)
          if (n <= 0) break
          offset += n
        }
        return {
          data: offset === toRead ? data : data.subarray(0, offset),
          truncated: toRead < st.size,
          size: st.size,
          mtimeMs: st.mtime * 1000
        }
      } finally {
        await sfClose(sftp, handle).catch(() => undefined)
      }
    })
  }

  async writeFileAtomic(path: string, data: Buffer, mode?: number): Promise<void> {
    return this.run('writeFileAtomic', async (sftp) => {
      const abs = await this.expand(sftp, path)
      const tmp = abs + '.ra-tmp-' + randomBytes(4).toString('hex')
      let handle: Buffer | null = null
      try {
        handle = await sfOpen(sftp, tmp, 'w')
        for (let off = 0; off < data.length; off += IO_CHUNK) {
          const len = Math.min(IO_CHUNK, data.length - off)
          await sfWrite(sftp, handle, data, off, len, off)
        }
        await sfClose(sftp, handle)
        handle = null
        if (mode !== undefined) await sfChmod(sftp, tmp, mode)
        await this.renameOver(sftp, tmp, abs)
      } catch (err) {
        if (handle) await sfClose(sftp, handle).catch(() => undefined)
        await sfUnlink(sftp, tmp).catch(() => undefined)
        throw err
      }
    })
  }

  async stat(path: string): Promise<{ isDir: boolean; size: number; mtimeMs: number } | null> {
    return this.run('stat', async (sftp) => {
      const abs = await this.expand(sftp, path)
      try {
        const st = await sfStat(sftp, abs)
        return { isDir: (st.mode & S_IFMT) === S_IFDIR, size: st.size, mtimeMs: st.mtime * 1000 }
      } catch (err) {
        if (isNoSuchFile(err)) return null
        throw err
      }
    })
  }

  async readdir(path: string): Promise<Array<{ name: string; isDir: boolean }>> {
    return this.run('readdir', async (sftp) => {
      const abs = await this.expand(sftp, path)
      let list: Array<{ filename: string; attrs: { mode: number } }>
      try {
        list = await sfReaddir(sftp, abs)
      } catch (err) {
        if (isNoSuchFile(err)) throw new CodedError('not-found', `no such directory: ${abs}`)
        throw err
      }
      return list.map((e) => ({
        name: e.filename,
        isDir: (e.attrs.mode & S_IFMT) === S_IFDIR
      }))
    })
  }

  async mkdirp(path: string): Promise<void> {
    return this.run('mkdirp', async (sftp) => {
      const abs = await this.expand(sftp, path)
      const parts = abs.split('/').filter((s) => s.length > 0)
      const absolute = abs.startsWith('/')
      let cur = ''
      for (const part of parts) {
        cur = cur.length === 0 && !absolute ? part : `${cur}/${part}`
        await sfMkdir(sftp, cur).catch(() => undefined) // already exists (or races) are fine
      }
      // verify the final path is a directory
      let ok = false
      try {
        const st = await sfStat(sftp, abs)
        ok = (st.mode & S_IFMT) === S_IFDIR
      } catch {
        ok = false
      }
      if (!ok) throw new CodedError('sftp-failed', `mkdirp failed: ${abs} is not a directory`)
    })
  }

  async unlink(path: string): Promise<void> {
    return this.run('unlink', async (sftp) => {
      const abs = await this.expand(sftp, path)
      try {
        await sfUnlink(sftp, abs)
      } catch (err) {
        if (isNoSuchFile(err)) throw new CodedError('not-found', `no such file: ${abs}`)
        throw err
      }
    })
  }

  async realpath(path: string): Promise<string> {
    return this.run('realpath', async (sftp) => {
      const abs = await this.expand(sftp, path)
      return sfRealpath(sftp, abs)
    })
  }

  // ---------------- internals ----------------

  /** Serialize every operation; wrap failures in CodedError with a 30s timeout. */
  private run<T>(label: string, fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const sftp = await this.acquire()
      try {
        return await this.withTimeout(fn(sftp), label)
      } catch (err) {
        throw toSftpError(err, label)
      }
    })
    this.queue = task.then(
      () => undefined,
      () => undefined
    )
    return task
  }

  private withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        // a stuck op usually means a dead channel; force a re-open next time
        this.sftp = null
        reject(new CodedError('timeout', `sftp ${label} timed out after ${OP_TIMEOUT_MS}ms`))
      }, OP_TIMEOUT_MS)
      p.then(
        (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        (err) => {
          clearTimeout(timer)
          reject(err)
        }
      )
    })
  }

  private acquire(): Promise<SFTPWrapper> {
    if (this.sftp) return Promise.resolve(this.sftp)
    if (this.opening) return this.opening
    const client = getConnectionManager().getClient(this.hostId) // throws not-connected
    const opening = new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err) {
          reject(new CodedError('sftp-failed', `cannot open sftp channel: ${err.message}`))
          return
        }
        const drop = (): void => {
          if (this.sftp === sftp) this.sftp = null
        }
        sftp.on('error', drop)
        sftp.on('close', drop)
        sftp.on('end', drop)
        this.sftp = sftp
        resolve(sftp)
      })
    }).finally(() => {
      this.opening = null
    })
    this.opening = opening
    return opening
  }

  /** Expand "~"-prefixed paths using the remote home dir (cached realpath "."). */
  private async expand(sftp: SFTPWrapper, path: string): Promise<string> {
    if (path !== '~' && !path.startsWith('~/')) return path
    if (this.home === null) this.home = await sfRealpath(sftp, '.')
    return path === '~' ? this.home : `${this.home}/${path.slice(2)}`
  }

  /** Rename that overwrites the target: posix-rename when available, else unlink+rename. */
  private async renameOver(sftp: SFTPWrapper, src: string, dest: string): Promise<void> {
    try {
      await sfPosixRename(sftp, src, dest)
      return
    } catch {
      // extension unsupported or failed; fall back below
    }
    await sfUnlink(sftp, dest).catch(() => undefined)
    await sfRename(sftp, src, dest)
  }
}

// ---------------- per-host singletons ----------------

const services = new Map<string, SftpService>()

export function getSftpService(hostId: string): SftpService {
  let svc = services.get(hostId)
  if (!svc) {
    svc = new SftpService(hostId)
    services.set(hostId, svc)
  }
  return svc
}
