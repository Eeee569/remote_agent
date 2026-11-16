/**
 * App state + the connection lifecycle. One host is active at a time; its SSH
 * connection is re-established on its own whenever iOS drops it (which it does
 * shortly after the app is backgrounded) — nothing is lost, since the agents
 * live in tmux on the server.
 */
import { create } from 'zustand'
import type { ProjectMeta, SessionMeta } from '@shared/domain'
import { call, NativeError, on } from './native'
import { Remote } from './remote'

export type HostAuth =
  | { kind: 'password'; password: string }
  | { kind: 'device' }
  | { kind: 'key'; privateKey: string; passphrase?: string }

export interface HostRecord {
  id: string
  label: string
  host: string
  port: number
  username: string
  auth: HostAuth
  /** TOFU-pinned host key fingerprint, set on the first successful connect */
  hostKey?: string
}

export interface DeviceKey {
  seed: string
  publicKey: string
}

export type Screen =
  | { name: 'hosts' }
  | { name: 'hostForm'; hostId: string | null }
  | { name: 'host' }
  | { name: 'session'; projectId: string; sessionId: string }

export type ConnStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

interface AppState {
  loaded: boolean
  hosts: HostRecord[]
  deviceKey: DeviceKey | null
  screen: Screen
  activeHostId: string | null
  status: ConnStatus
  error: { code: string; message: string } | null
  remote: Remote | null
  projects: ProjectMeta[]
  sessions: Record<string, SessionMeta[]>
  overviewLoaded: boolean
  notice: string | null
  fontSize: number
}

const FONT_KEY = 'ra-font-size'

function storedFontSize(): number {
  try {
    const n = Number(localStorage.getItem(FONT_KEY))
    if (n >= 8 && n <= 22) return n
  } catch {
    // storage unavailable
  }
  return 12
}

export const useApp = create<AppState>(() => ({
  loaded: false,
  hosts: [],
  deviceKey: null,
  screen: { name: 'hosts' },
  activeHostId: null,
  status: 'idle',
  error: null,
  remote: null,
  projects: [],
  sessions: {},
  overviewLoaded: false,
  notice: null,
  fontSize: storedFontSize()
}))

const set = useApp.setState
const get = useApp.getState

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

let noticeTimer: number | null = null
export function notify(message: string): void {
  set({ notice: message })
  if (noticeTimer !== null) window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => set({ notice: null }), 3500)
}

export function setFontSize(size: number): void {
  const next = Math.min(22, Math.max(8, size))
  set({ fontSize: next })
  try {
    localStorage.setItem(FONT_KEY, String(next))
  } catch {
    // storage unavailable
  }
}

export function go(screen: Screen): void {
  set({ screen })
}

// ---------------- persistence (Keychain-backed on the phone) ----------------

async function storeGet<T>(key: string): Promise<T | null> {
  const { value } = await call<{ value: string | null }>('store.get', { key })
  if (value === null) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

async function storeSet(key: string, value: unknown): Promise<void> {
  await call('store.set', { key, value: JSON.stringify(value) })
}

export async function loadStore(): Promise<void> {
  const [hosts, deviceKey] = await Promise.all([
    storeGet<HostRecord[]>('hosts'),
    storeGet<DeviceKey>('deviceKey')
  ])
  set({ hosts: hosts ?? [], deviceKey, loaded: true })
}

export async function ensureDeviceKey(): Promise<DeviceKey> {
  const existing = get().deviceKey
  if (existing) return existing
  const key = await call<DeviceKey>('key.generate')
  await storeSet('deviceKey', key)
  set({ deviceKey: key })
  return key
}

export async function saveHost(host: HostRecord): Promise<void> {
  const hosts = get().hosts
  const next = hosts.some((h) => h.id === host.id)
    ? hosts.map((h) => (h.id === host.id ? host : h))
    : [...hosts, host]
  set({ hosts: next })
  await storeSet('hosts', next)
}

export async function deleteHost(hostId: string): Promise<void> {
  const next = get().hosts.filter((h) => h.id !== hostId)
  set({ hosts: next })
  await storeSet('hosts', next)
}

export function activeHost(): HostRecord | undefined {
  const { hosts, activeHostId } = get()
  return hosts.find((h) => h.id === activeHostId)
}

// ---------------- connection ----------------

/** bumped whenever the active host changes, so stale async work drops out */
let generation = 0
let retryTimer: number | null = null
let attempt = 0

function clearRetry(): void {
  if (retryTimer !== null) {
    window.clearTimeout(retryTimer)
    retryTimer = null
  }
}

function authParams(host: HostRecord, deviceKey: DeviceKey | null): Record<string, unknown> {
  if (host.auth.kind === 'password') return { kind: 'password', password: host.auth.password }
  if (host.auth.kind === 'device') return { kind: 'generated', seed: deviceKey?.seed ?? '' }
  return {
    kind: 'key',
    privateKey: host.auth.privateKey,
    ...(host.auth.passphrase ? { passphrase: host.auth.passphrase } : {})
  }
}

/** Errors another attempt cannot fix; the user has to change something. */
const FATAL = new Set(['auth-failed', 'host-key-mismatch', 'bad-key', 'bad-args'])

async function connect(initial: boolean): Promise<void> {
  const host = activeHost()
  if (!host) return
  const gen = generation
  clearRetry()
  set({ status: initial ? 'connecting' : 'reconnecting', ...(initial ? { error: null } : {}) })
  try {
    const deviceKey = host.auth.kind === 'device' ? await ensureDeviceKey() : get().deviceKey
    const res = await call<{ connId: string; hostKey: string }>('ssh.connect', {
      host: host.host,
      port: host.port,
      username: host.username,
      auth: authParams(host, deviceKey),
      ...(host.hostKey ? { pinnedHostKey: host.hostKey } : {})
    })
    if (gen !== generation) {
      void call('ssh.disconnect', { connId: res.connId }).catch(() => undefined)
      return
    }
    if (!host.hostKey && res.hostKey) await saveHost({ ...host, hostKey: res.hostKey })
    const remote = new Remote(res.connId)
    attempt = 0
    set({ status: 'connected', error: null, remote })
    try {
      await remote.ensureHelper()
    } catch (err) {
      if (gen !== generation) return
      set({ error: { code: 'helper', message: `Server helper: ${errText(err)}` } })
      return
    }
    await refreshOverview()
  } catch (err) {
    if (gen !== generation) return
    const code = err instanceof NativeError ? err.code : 'conn-failed'
    const error = { code, message: errText(err) }
    if (FATAL.has(code)) {
      set({ status: 'failed', error, remote: null })
      return
    }
    // unreachable right now (no network yet after waking, host down) — keep trying
    attempt++
    set({ status: 'reconnecting', error, remote: null })
    retryTimer = window.setTimeout(() => void connect(false), Math.min(1000 * 2 ** (attempt - 1), 10_000))
  }
}

export function openHost(hostId: string): void {
  generation++
  attempt = 0
  set({
    activeHostId: hostId,
    screen: { name: 'host' },
    projects: [],
    sessions: {},
    overviewLoaded: false,
    remote: null,
    error: null
  })
  void connect(true)
}

export function retryConnect(): void {
  attempt = 0
  void connect(true)
}

/** Re-pin: the user accepts that the host presented a different key. */
export async function trustNewHostKey(): Promise<void> {
  const host = activeHost()
  if (!host) return
  const { hostKey: _dropped, ...rest } = host
  await saveHost(rest)
  retryConnect()
}

export function leaveHost(): void {
  generation++
  clearRetry()
  const remote = get().remote
  if (remote) void call('ssh.disconnect', { connId: remote.connId }).catch(() => undefined)
  set({
    activeHostId: null,
    screen: { name: 'hosts' },
    status: 'idle',
    error: null,
    remote: null,
    projects: [],
    sessions: {},
    overviewLoaded: false
  })
}

function connectionLost(): void {
  if (get().activeHostId === null) return
  set({ remote: null, status: 'reconnecting' })
  attempt = 0
  void connect(false)
}

on('ssh.closed', (payload) => {
  if (payload.connId === get().remote?.connId) connectionLost()
})

/**
 * A suspended app's sockets die without the app being told. When it comes
 * back to the foreground, prove the connection still works rather than letting
 * the user type into a dead terminal.
 */
let checking = false
async function healthCheck(): Promise<void> {
  const remote = get().remote
  if (!remote || checking) return
  checking = true
  try {
    await remote.exec('true', { timeoutMs: 4000 })
  } catch {
    if (get().remote === remote) {
      await call('ssh.disconnect', { connId: remote.connId }).catch(() => undefined)
      if (get().remote === remote) connectionLost()
    }
  } finally {
    checking = false
  }
}

on('app.foreground', () => void healthCheck())
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') void healthCheck()
})
window.setInterval(() => {
  if (document.visibilityState === 'visible') void healthCheck()
}, 30_000)

// ---------------- projects / sessions ----------------

let refreshing: Promise<void> | null = null

export function refreshOverview(): Promise<void> {
  if (refreshing) return refreshing
  const remote = get().remote
  if (!remote) return Promise.resolve()
  refreshing = (async () => {
    try {
      const { projects, sessions } = await remote.overview()
      if (get().remote !== remote) return
      set({ projects, sessions, overviewLoaded: true })
      if (get().error?.code === 'overview') set({ error: null })
    } catch (err) {
      if (get().remote === remote) {
        set({ error: { code: 'overview', message: errText(err) } })
      }
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

export function findSession(
  projectId: string,
  sessionId: string
): { project: ProjectMeta; session: SessionMeta } | null {
  const { projects, sessions } = get()
  const project = projects.find((p) => p.id === projectId)
  const session = (sessions[projectId] ?? []).find((s) => s.id === sessionId)
  return project && session ? { project, session } : null
}
