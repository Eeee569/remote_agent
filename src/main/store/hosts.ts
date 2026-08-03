/**
 * Local persistence for host records + small bits of UI state.
 * JSON file at <userData>/config.json, shape:
 *   { "version": 1, "hosts": [...], "ui": { "lastHostId": null, "openProjectIds": [] } }
 * Synchronous fs, atomic writes (tmp + rename), lazy load with corrupt-file
 * fallback to an empty config. Key passphrases are stored encrypted via
 * Electron safeStorage (base64 of encryptString output).
 */
import { app, safeStorage } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { HostConfig, HostPublic, HostSaveInput } from '../../shared/domain'
import { CodedError } from '../util/errors'
import { newId } from '../util/ids'

export interface UiState {
  lastHostId: string | null
  openProjectIds: string[]
}

interface ConfigFile {
  version: 1
  hosts: HostConfig[]
  ui: UiState
}

function defaultConfig(): ConfigFile {
  return { version: 1, hosts: [], ui: { lastHostId: null, openProjectIds: [] } }
}

let cache: ConfigFile | null = null

function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

function load(): ConfigFile {
  if (cache) return cache
  try {
    const raw = readFileSync(configPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<ConfigFile> | null
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.hosts)) {
      cache = defaultConfig()
    } else {
      const ui: Partial<Record<keyof UiState, unknown>> =
        parsed.ui && typeof parsed.ui === 'object' ? parsed.ui : {}
      cache = {
        version: 1,
        hosts: parsed.hosts,
        ui: {
          lastHostId: typeof ui.lastHostId === 'string' ? ui.lastHostId : null,
          openProjectIds: Array.isArray(ui.openProjectIds)
            ? ui.openProjectIds.filter((x): x is string => typeof x === 'string')
            : []
        }
      }
    }
  } catch {
    // missing or corrupt file -> start empty (never crash on startup)
    cache = defaultConfig()
  }
  return cache
}

function persist(cfg: ConfigFile): void {
  cache = cfg
  const file = configPath()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

// ---------------- hosts ----------------

export function listHosts(): HostConfig[] {
  return [...load().hosts]
}

export function getHost(id: string): HostConfig | undefined {
  return load().hosts.find((h) => h.id === id)
}

export function saveHost(input: HostSaveInput): HostConfig {
  const cfg = load()
  const existing = input.id ? cfg.hosts.find((h) => h.id === input.id) : undefined
  const id = existing?.id ?? input.id ?? newId('h_')

  let auth: HostConfig['auth']
  if (input.authKind === 'agent') {
    auth = { kind: 'agent' }
  } else {
    const keyPath =
      input.keyPath ?? (existing?.auth.kind === 'key' ? existing.auth.keyPath : '')
    let passphraseEnc: string | undefined
    if (input.passphrase === undefined) {
      // leave stored passphrase unchanged
      passphraseEnc = existing?.auth.kind === 'key' ? existing.auth.passphraseEnc : undefined
    } else if (input.passphrase === null) {
      passphraseEnc = undefined
    } else {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new CodedError(
          'encryption-unavailable',
          'Cannot store the key passphrase: OS-level encryption (safeStorage) is unavailable'
        )
      }
      passphraseEnc = safeStorage.encryptString(input.passphrase).toString('base64')
    }
    auth = { kind: 'key', keyPath, ...(passphraseEnc !== undefined ? { passphraseEnc } : {}) }
  }

  // Keep the TOFU-pinned host key only while the endpoint is unchanged.
  const keepHostKey =
    existing?.hostKey && existing.host === input.host && existing.port === input.port
      ? existing.hostKey
      : undefined

  const host: HostConfig = {
    id,
    label: input.label,
    host: input.host,
    port: input.port,
    username: input.username,
    auth,
    ...(keepHostKey ? { hostKey: keepHostKey } : {})
  }

  const idx = cfg.hosts.findIndex((h) => h.id === id)
  const hosts = [...cfg.hosts]
  if (idx >= 0) hosts[idx] = host
  else hosts.push(host)
  persist({ ...cfg, hosts })
  return host
}

export function deleteHost(id: string): void {
  const cfg = load()
  const hosts = cfg.hosts.filter((h) => h.id !== id)
  const ui: UiState = {
    ...cfg.ui,
    lastHostId: cfg.ui.lastHostId === id ? null : cfg.ui.lastHostId
  }
  persist({ ...cfg, hosts, ui })
}

export function toPublic(h: HostConfig): HostPublic {
  return {
    id: h.id,
    label: h.label,
    host: h.host,
    port: h.port,
    username: h.username,
    authKind: h.auth.kind,
    ...(h.auth.kind === 'key' ? { keyPath: h.auth.keyPath } : {}),
    hasPassphrase: h.auth.kind === 'key' && !!h.auth.passphraseEnc,
    ...(h.hostKey ? { hostKeyFingerprint: h.hostKey.fingerprint } : {})
  }
}

/** Decrypts the stored passphrase; undefined when absent or undecryptable. */
export function getPassphrase(h: HostConfig): string | undefined {
  if (h.auth.kind !== 'key' || !h.auth.passphraseEnc) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(h.auth.passphraseEnc, 'base64'))
  } catch {
    return undefined
  }
}

export function setHostKey(id: string, algo: string, fingerprint: string): void {
  const cfg = load()
  const idx = cfg.hosts.findIndex((h) => h.id === id)
  if (idx < 0) throw new CodedError('not-found', `host ${id} not found`)
  const hosts = [...cfg.hosts]
  hosts[idx] = { ...hosts[idx], hostKey: { algo, fingerprint } }
  persist({ ...cfg, hosts })
}

// ---------------- ui state ----------------

export function getUiState(): UiState {
  const ui = load().ui
  return { lastHostId: ui.lastHostId, openProjectIds: [...ui.openProjectIds] }
}

export function setUiState(partial: Partial<UiState>): void {
  const cfg = load()
  persist({ ...cfg, ui: { ...cfg.ui, ...partial } })
}
