/**
 * Transport to the native half of the app (ios/RemoteAgentCore's Bridge).
 *
 * Inside the app this is WKWebView's script-message channel; under
 * ios/dev/server.mjs it is HTTP + server-sent events onto the very same Swift
 * bridge running on Linux, so the UI is developed against the real thing.
 */

export class NativeError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'NativeError'
  }
}

interface WebkitWindow {
  webkit?: { messageHandlers?: { ra?: { postMessage(message: string): void } } }
  __raReceive?: (message: Incoming) => void
}

type Incoming =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: { code: string; message: string } }
  | ({ event: string } & Record<string, unknown>)

const w = window as unknown as WebkitWindow
const handler = w.webkit?.messageHandlers?.ra
export const isNativeApp = handler !== undefined

const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const listeners = new Map<string, Set<(payload: Record<string, unknown>) => void>>()
let nextId = 1

/** dev transport only: separate HTTP requests can overtake each other, so chain them */
let devQueue: Promise<unknown> = Promise.resolve()

function send(message: object): void {
  const text = JSON.stringify(message)
  if (handler) {
    handler.postMessage(text)
  } else {
    devQueue = devQueue.then(() => fetch('/rpc', { method: 'POST', body: text }).catch(() => undefined))
  }
}

w.__raReceive = (message: Incoming): void => {
  if ('event' in message) {
    for (const fn of listeners.get(message.event) ?? []) fn(message)
    return
  }
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  if (message.ok) entry.resolve(message.result)
  else entry.reject(new NativeError(message.error.code, message.error.message))
}

if (!handler) {
  const source = new EventSource('/events')
  source.onmessage = (e) => w.__raReceive?.(JSON.parse(e.data as string) as Incoming)
}

/** Request/response call into the native bridge. */
export function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    send({ id, method, params })
  })
}

/** Fire-and-forget message (terminal input), delivered in order. */
export function post(method: string, params: Record<string, unknown>): void {
  send({ method, params })
}

export function on(event: string, fn: (payload: Record<string, unknown>) => void): () => void {
  let set = listeners.get(event)
  if (!set) {
    set = new Set()
    listeners.set(event, set)
  }
  set.add(fn)
  return () => {
    set.delete(fn)
  }
}

// ---------- base64 <-> bytes ----------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

// ---------- clipboard ----------

export async function clipboardRead(): Promise<string> {
  try {
    return (await call<{ text: string }>('clipboard.read')).text
  } catch {
    try {
      return await navigator.clipboard.readText()
    } catch {
      return ''
    }
  }
}

export function clipboardWrite(text: string): void {
  call('clipboard.write', { text }).catch(() => {
    void navigator.clipboard?.writeText(text).catch(() => undefined)
  })
}
