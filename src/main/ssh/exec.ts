/**
 * Promise wrappers around ssh2 `client.exec` for one-shot commands
 * (buffered) and streaming installer-style output (line-buffered).
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

export function execCommand(
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

    client.exec(command, (err, stream) => {
      if (err) return fail(err)
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
    })
  })
}

export function execStream(
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

    client.exec(command, (err, stream) => {
      if (err) return fail(err)
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
    })
  })
}
