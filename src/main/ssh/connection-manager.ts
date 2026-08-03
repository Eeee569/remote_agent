/**
 * One multiplexed ssh2 Client per host, with TOFU host-key pinning,
 * auto-reconnect (exponential backoff + jitter) while a host is "wanted",
 * and status events consumed by the IPC layer / other services.
 */
import { Client } from 'ssh2'
import type { ConnectConfig } from 'ssh2'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { ConnEvent, ConnStatus, HostConfig, HostSaveInput, HostTestResult } from '../../shared/domain'
import { getHost, getPassphrase, setHostKey } from '../store/hosts'
import { CodedError } from '../util/errors'

export type StatusListener = (e: ConnEvent) => void

const KEEPALIVE_INTERVAL_MS = 10_000
const KEEPALIVE_COUNT_MAX = 3
const READY_TIMEOUT_MS = 15_000
const BACKOFF_BASE_MS = 1_000
const BACKOFF_CAP_MS = 30_000

// ---------------- helpers ----------------

function expanduser(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p
}

/** OpenSSH-style fingerprint: "SHA256:" + base64(sha256(key blob)), no padding. */
function fingerprintOf(key: Buffer): string {
  return 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=+$/, '')
}

/** The key blob starts with a uint32-length-prefixed algorithm name (e.g. "ssh-ed25519"). */
function algoOf(key: Buffer): string {
  try {
    if (key.length >= 4) {
      const len = key.readUInt32BE(0)
      if (len > 0 && len <= 64 && key.length >= 4 + len) {
        return key.subarray(4, 4 + len).toString('latin1')
      }
    }
  } catch {
    // fall through
  }
  return 'unknown'
}

function toCoded(err: unknown): CodedError {
  if (err instanceof CodedError) return err
  const msg = err instanceof Error ? err.message : String(err)
  return new CodedError('conn-failed', msg)
}

function classify(err: Error & { level?: string }, hostkeyMismatch: boolean): CodedError {
  if (hostkeyMismatch) {
    return new CodedError('hostkey-mismatch', 'Host key verification failed: server key does not match the pinned fingerprint')
  }
  if (err instanceof CodedError) return err
  if (err.level === 'client-authentication') {
    return new CodedError('auth-failed', err.message || 'Authentication failed')
  }
  if (err.level === 'client-timeout') {
    return new CodedError('timeout', err.message || 'Connection timed out')
  }
  return new CodedError('conn-failed', err.message || 'Connection failed')
}

/** Failure codes that stop the reconnect loop and clear `wanted`. */
function isNonRetryable(code: string): boolean {
  return code === 'auth-failed' || code === 'hostkey-mismatch' || code === 'not-found'
}

// ---------------- connection manager ----------------

interface Entry {
  client: Client | null
  status: ConnStatus
  wanted: boolean
  attempt: number
  retryTimer: NodeJS.Timeout | null
  inflight: Promise<void> | null
  lastError: CodedError | null
}

export class ConnectionManager {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<StatusListener>()

  onStatus(cb: StatusListener): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  status(hostId: string): ConnStatus {
    return this.entries.get(hostId)?.status ?? 'idle'
  }

  getClient(hostId: string): Client {
    const e = this.entries.get(hostId)
    if (!e || e.status !== 'connected' || !e.client) {
      throw new CodedError('not-connected', `host ${hostId} is not connected`)
    }
    return e.client
  }

  setWanted(hostId: string, wanted: boolean): void {
    const e = this.entry(hostId)
    e.wanted = wanted
    if (!wanted) {
      this.cancelRetry(e)
      if (e.status === 'reconnecting') this.setStatus(hostId, e, 'idle')
    }
  }

  /** Idempotent; resolves when the connection is ready. Marks the host wanted. */
  connect(hostId: string): Promise<void> {
    const e = this.entry(hostId)
    e.wanted = true
    if (e.status === 'connected' && e.client) return Promise.resolve()
    if (e.inflight) return e.inflight
    // manual connect resets the backoff
    this.cancelRetry(e)
    e.attempt = 0
    this.setStatus(hostId, e, 'connecting')
    return this.attemptConnect(hostId, e)
  }

  async disconnect(hostId: string): Promise<void> {
    const e = this.entries.get(hostId)
    if (!e) return
    e.wanted = false
    this.cancelRetry(e)
    const client = e.client
    e.client = null
    // abandon the superseded attempt so a later connect() starts a fresh one
    e.inflight = null
    if (e.status !== 'idle') this.setStatus(hostId, e, 'idle')
    if (client) {
      try {
        client.end()
      } catch {
        // ignore
      }
    }
  }

  /** Ends every client and cancels all timers; used on app quit. */
  shutdown(): void {
    for (const e of this.entries.values()) {
      e.wanted = false
      this.cancelRetry(e)
      const client = e.client
      e.client = null
      e.inflight = null
      e.status = 'idle'
      if (client) {
        try {
          client.end()
        } catch {
          // ignore
        }
      }
    }
  }

  // ---------------- internals ----------------

  private entry(hostId: string): Entry {
    let e = this.entries.get(hostId)
    if (!e) {
      e = {
        client: null,
        status: 'idle',
        wanted: false,
        attempt: 0,
        retryTimer: null,
        inflight: null,
        lastError: null
      }
      this.entries.set(hostId, e)
    }
    return e
  }

  private emit(e: ConnEvent): void {
    for (const cb of this.listeners) {
      try {
        cb(e)
      } catch {
        // listener errors must not break the manager
      }
    }
  }

  private setStatus(hostId: string, e: Entry, status: ConnStatus, extra?: Partial<ConnEvent>): void {
    e.status = status
    this.emit({ hostId, status, ...extra })
  }

  private cancelRetry(e: Entry): void {
    if (e.retryTimer) {
      clearTimeout(e.retryTimer)
      e.retryTimer = null
    }
  }

  private attemptConnect(hostId: string, e: Entry): Promise<void> {
    const p = new Promise<void>((resolve, reject) => {
      e.lastError = null
      let mismatch = false
      let config: ConnectConfig
      try {
        const host = getHost(hostId)
        if (!host) throw new CodedError('not-found', `host ${hostId} not found`)
        config = this.buildConfig(hostId, host, (key) => {
          const fp = fingerprintOf(key)
          if (!host.hostKey) {
            // trust on first use: pin the key
            try {
              setHostKey(hostId, algoOf(key), fp)
            } catch {
              // host deleted mid-connect; still allow this attempt
            }
            return true
          }
          if (host.hostKey.fingerprint === fp) return true
          mismatch = true
          return false
        })
      } catch (err) {
        e.lastError = toCoded(err)
        this.afterDrop(hostId, e)
        reject(e.lastError)
        return
      }

      const client = new Client()
      e.client = client
      let ready = false

      client.on('ready', () => {
        ready = true
        e.attempt = 0
        e.lastError = null
        this.setStatus(hostId, e, 'connected')
        resolve()
      })
      client.on('error', (err: Error & { level?: string }) => {
        const coded = classify(err, mismatch)
        e.lastError = coded
        if (!ready) reject(coded)
      })
      client.on('close', () => {
        // settle a pending connect if the socket dies before ready and no
        // 'error' fired (e.g. manual disconnect mid-handshake); no-op if settled
        if (!ready) {
          reject(e.lastError ?? new CodedError('conn-failed', 'connection closed before ready'))
        }
        if (e.client !== client) return // superseded or manually disconnected
        e.client = null
        this.afterDrop(hostId, e)
      })
      try {
        // ssh2 validates the private key synchronously and throws for an
        // unparsable key or a wrong passphrase: no socket, so no close event
        client.connect(config)
      } catch (err) {
        e.lastError = toCoded(err)
        if (e.client === client) {
          e.client = null
          this.afterDrop(hostId, e)
        }
        reject(e.lastError)
      }
    })
    const tracked = p.finally(() => {
      if (e.inflight === tracked) e.inflight = null
    })
    e.inflight = tracked
    return tracked
  }

  private buildConfig(
    hostId: string,
    host: HostConfig,
    verifier: (key: Buffer) => boolean
  ): ConnectConfig {
    const config: ConnectConfig = {
      host: host.host,
      port: host.port,
      username: host.username,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: KEEPALIVE_COUNT_MAX,
      readyTimeout: READY_TIMEOUT_MS,
      hostVerifier: verifier
    }
    if (host.auth.kind === 'agent') {
      const sock = process.env['SSH_AUTH_SOCK']
      if (!sock) {
        throw new CodedError('conn-failed', `SSH agent auth for host ${hostId} requires SSH_AUTH_SOCK to be set`)
      }
      config.agent = sock
    } else {
      try {
        config.privateKey = readFileSync(expanduser(host.auth.keyPath))
      } catch (err) {
        throw new CodedError('conn-failed', `cannot read private key ${host.auth.keyPath}: ${(err as Error).message}`)
      }
      const passphrase = getPassphrase(host)
      if (passphrase !== undefined) config.passphrase = passphrase
    }
    return config
  }

  /** Runs after a connection is gone (close event or failed config build). */
  private afterDrop(hostId: string, e: Entry): void {
    if (!e.wanted) {
      if (e.status !== 'idle') this.setStatus(hostId, e, 'idle')
      return
    }
    const err = e.lastError
    if (err && isNonRetryable(err.code)) {
      e.wanted = false
      this.cancelRetry(e)
      this.setStatus(hostId, e, 'failed', { error: err.message })
      return
    }
    this.scheduleReconnect(hostId, e)
  }

  private scheduleReconnect(hostId: string, e: Entry): void {
    if (e.retryTimer) return
    e.attempt += 1
    const base = Math.min(BACKOFF_BASE_MS * 2 ** (e.attempt - 1), BACKOFF_CAP_MS)
    const nextRetryMs = Math.round(base * (0.8 + Math.random() * 0.4)) // +-20% jitter
    this.setStatus(hostId, e, 'reconnecting', {
      attempt: e.attempt,
      nextRetryMs,
      ...(e.lastError ? { error: e.lastError.message } : {})
    })
    e.retryTimer = setTimeout(() => {
      e.retryTimer = null
      if (!e.wanted || e.client) return
      this.attemptConnect(hostId, e).catch(() => {
        // the close handler reschedules; nothing to do here
      })
    }, nextRetryMs)
  }
}

// ---------------- singleton ----------------

let manager: ConnectionManager | null = null

export function getConnectionManager(): ConnectionManager {
  if (!manager) manager = new ConnectionManager()
  return manager
}

/** Called from main index on quit: ends all clients, cancels timers. */
export function shutdownAllConnections(): void {
  manager?.shutdown()
}

// ---------------- one-shot host test ----------------

/**
 * Throwaway Client used by the "Test connection" button. Never touches the
 * hosts store; the caller passes the pinned fingerprint (if any) explicitly.
 */
export function testHost(input: HostSaveInput, storedFingerprint?: string): Promise<HostTestResult> {
  return new Promise<HostTestResult>((resolve) => {
    let settled = false
    let banner: string | undefined
    let fp: string | undefined
    let algo: string | undefined
    let mismatch = false

    const finish = (r: HostTestResult): void => {
      if (settled) return
      settled = true
      resolve({
        ...r,
        ...(banner !== undefined ? { banner } : {}),
        ...(fp !== undefined ? { hostKeyFingerprint: fp } : {}),
        ...(algo !== undefined ? { hostKeyAlgo: algo } : {})
      })
    }

    const config: ConnectConfig = {
      host: input.host,
      port: input.port,
      username: input.username,
      readyTimeout: READY_TIMEOUT_MS,
      hostVerifier: (key: Buffer): boolean => {
        fp = fingerprintOf(key)
        algo = algoOf(key)
        if (storedFingerprint !== undefined && storedFingerprint !== fp) {
          mismatch = true
          return false
        }
        return true
      }
    }
    try {
      if (input.authKind === 'agent') {
        const sock = process.env['SSH_AUTH_SOCK']
        if (!sock) throw new CodedError('conn-failed', 'SSH agent auth requires SSH_AUTH_SOCK to be set')
        config.agent = sock
      } else {
        config.privateKey = readFileSync(expanduser(input.keyPath ?? ''))
        if (typeof input.passphrase === 'string') config.passphrase = input.passphrase
      }
    } catch (err) {
      finish({ ok: false, error: toCoded(err).message })
      return
    }

    const client = new Client()
    client.on('greeting', (greeting: string) => {
      const g = greeting.trim()
      if (g && banner === undefined) banner = g
    })
    client.on('banner', (message: string) => {
      const b = message.trim()
      if (b) banner = b
    })
    client.on('ready', () => {
      finish({ ok: true })
      try {
        client.end()
      } catch {
        // ignore
      }
    })
    client.on('error', (err: Error & { level?: string }) => {
      finish({ ok: false, error: classify(err, mismatch).message })
      try {
        client.end()
      } catch {
        // ignore
      }
    })
    client.on('close', () => {
      finish({ ok: false, error: 'connection closed before authentication completed' })
    })
    try {
      client.connect(config)
    } catch (err) {
      finish({ ok: false, error: toCoded(err).message })
    }
  })
}
