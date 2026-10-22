/**
 * Promise wrappers around ssh2 `client.exec` for one-shot commands
 * (buffered) and streaming installer-style output (line-buffered).
 *
 * Every exec opens an SSH session channel, and sshd caps how many a single
 * connection may hold open (MaxSessions, 10 by default). Attached terminals
 * already hold one each, so exec calls are queued through a small per-client
 * gate and retried when the server refuses a channel anyway.
 */
import type { Client, ClientChannel } from 'ssh2'
import { StringDecoder } from 'string_decoder'
import { CodedError } from '../util/errors'

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
}

const DEFAULT_EXEC_TIMEOUT_MS = 30_000
const DEFAULT_STREAM_TIMEOUT_MS = 600_000

/** Concurrent exec channels per connection; the rest wait in line. */
const MAX_CONCURRENT_EXEC = 3
/** Backoff for retrying a refused channel, in ms. */
const OPEN_RETRY_DELAYS = [150, 400, 900, 1800]

interface Gate {
  active: number
  waiting: Array<() => void>
}

const gates = new WeakMap<Client, Gate>()

function gateFor(client: Client): Gate {
  let gate = gates.get(client)
  if (!gate) {
    gate = { active: 0, waiting: [] }
    gates.set(client, gate)
  }
  return gate
}

function acquire(client: Client): Promise<void> {
  const gate = gateFor(client)
  if (gate.active < MAX_CONCURRENT_EXEC) {
    gate.active++
    return Promise.resolve()
  }
  return new Promise<void>((resolve) => {
    gate.waiting.push(() => {
      gate.active++
      resolve()
    })
  })
}

function release(client: Client): void {
  const gate = gateFor(client)
  gate.active = Math.max(0, gate.active - 1)
  const next = gate.waiting.shift()
  if (next) next()
}

/** sshd refusing a new channel — usually MaxSessions, and usually transient. */
function isChannelExhausted(err: Error): boolean {
  return /channel open failure|open failed|administratively prohibited|resource shortage/i.test(
    err.message
  )
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * `client.exec` with retries while the server keeps refusing channels. The
 * caller already holds a gate slot, so this only fires when something outside
 * our accounting (terminals, another client) is using the connection.
 */
function openExecChannel(client: Client, command: string): Promise<ClientChannel> {
  const attempt = (n: number): Promise<ClientChannel> =>
    new Promise<ClientChannel>((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) reject(err)
        else resolve(stream)
      })
    }).catch(async (err: Error) => {
      if (n >= OPEN_RETRY_DELAYS.length || !isChannelExhausted(err)) {
        if (isChannelExhausted(err)) {
          throw new CodedError(
            'channel-limit',
            'the SSH server refused another channel (MaxSessions). Detach a terminal ' +
              'or raise MaxSessions in sshd_config, then try again.'
          )
        }
        throw err
      }
      await sleep(OPEN_RETRY_DELAYS[n])
      return attempt(n + 1)
    })
  return attempt(0)
}

export async function execCommand(
  client: Client,
  command: string,
  opts?: { timeoutMs?: number; stdin?: string | Buffer }
): Promise<ExecResult> {
  await acquire(client)
  try {
    return await runCommand(client, command, opts)
  } finally {
    release(client)
  }
}

function runCommand(
  client: Client,
  command: string,
  opts?: { timeoutMs?: number; stdin?: string | Buffer }
): Promise<ExecResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS
  return new Promise<ExecResult>((resolve, reject) => {
    let settled = false
    let channel: ClientChannel | null = null
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        channel?.close()
      } catch {
        // ignore
      }
      reject(new CodedError('timeout', `command timed out after ${timeoutMs}ms: ${command}`))
    }, timeoutMs)

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err instanceof CodedError ? err : new CodedError('conn-failed', err.message))
    }

    openExecChannel(client, command).then((stream) => {
      channel = stream
      if (settled) {
        try {
          stream.close()
        } catch {
          // ignore
        }
        return
      }
      const out: Buffer[] = []
      const errChunks: Buffer[] = []
      let exitCode: number | null = null

      stream.on('data', (chunk: Buffer) => {
        out.push(chunk)
      })
      stream.stderr.on('data', (chunk: Buffer) => {
        errChunks.push(chunk)
      })
      stream.on('exit', (code: number | null) => {
        exitCode = typeof code === 'number' ? code : null
      })
      stream.on('error', fail)
      stream.on('close', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          code: exitCode,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(errChunks).toString('utf8')
        })
      })

      if (opts?.stdin !== undefined) {
        stream.end(opts.stdin)
      }
    }, fail)
  })
}

export async function execStream(
  client: Client,
  command: string,
  onLine: (line: string, stream: 'out' | 'err') => void,
  opts?: { timeoutMs?: number }
): Promise<{ code: number | null }> {
  await acquire(client)
  try {
    return await runStream(client, command, onLine, opts)
  } finally {
    release(client)
  }
}

function runStream(
  client: Client,
  command: string,
  onLine: (line: string, stream: 'out' | 'err') => void,
  opts?: { timeoutMs?: number }
): Promise<{ code: number | null }> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS
  return new Promise<{ code: number | null }>((resolve, reject) => {
    let settled = false
    let channel: ClientChannel | null = null
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        channel?.close()
      } catch {
        // ignore
      }
      reject(new CodedError('timeout', `command timed out after ${timeoutMs}ms: ${command}`))
    }, timeoutMs)

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err instanceof CodedError ? err : new CodedError('conn-failed', err.message))
    }

    openExecChannel(client, command).then((stream) => {
      channel = stream
      if (settled) {
        try {
          stream.close()
        } catch {
          // ignore
        }
        return
      }
      const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') }
      const pending = { out: '', err: '' }
      let exitCode: number | null = null

      const feed = (chunk: Buffer, which: 'out' | 'err'): void => {
        pending[which] += decoders[which].write(chunk)
        let idx = pending[which].indexOf('\n')
        while (idx >= 0) {
          const line = pending[which].slice(0, idx).replace(/\r$/, '')
          pending[which] = pending[which].slice(idx + 1)
          safeOnLine(line, which)
          idx = pending[which].indexOf('\n')
        }
      }
      const safeOnLine = (line: string, which: 'out' | 'err'): void => {
        try {
          onLine(line, which)
        } catch {
          // listener errors must not break the stream
        }
      }
      const flush = (which: 'out' | 'err'): void => {
        const rest = pending[which] + decoders[which].end()
        pending[which] = ''
        if (rest.length > 0) safeOnLine(rest.replace(/\r$/, ''), which)
      }

      stream.on('data', (chunk: Buffer) => feed(chunk, 'out'))
      stream.stderr.on('data', (chunk: Buffer) => feed(chunk, 'err'))
      stream.on('exit', (code: number | null) => {
        exitCode = typeof code === 'number' ? code : null
      })
      stream.on('error', fail)
      stream.on('close', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        flush('out')
        flush('err')
        resolve({ code: exitCode })
      })
    }, fail)
  })
}
