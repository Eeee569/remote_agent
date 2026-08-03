/**
 * PTY shell channels over ssh2. Emits coalesced "data" events (one flush per
 * 8ms tick or 32 KiB, whichever first) and "exit" events. Terminals are
 * closed automatically when their host's connection leaves "connected".
 */
import { EventEmitter } from 'events'
import type { ClientChannel } from 'ssh2'
import type { TermDataEvent, TermExitEvent, TermExitReason } from '../../shared/domain'
import { getConnectionManager } from './connection-manager'
import { CodedError } from '../util/errors'
import { newId } from '../util/ids'

const FLUSH_INTERVAL_MS = 8
const FLUSH_THRESHOLD_BYTES = 32 * 1024

interface Term {
  termId: string
  hostId: string
  stream: ClientChannel
  chunks: Buffer[]
  buffered: number
  flushTimer: NodeJS.Timeout | null
  closed: boolean
}

export class TerminalService extends EventEmitter {
  private readonly terms = new Map<string, Term>()

  constructor() {
    super()
    getConnectionManager().onStatus((e) => {
      if (e.status !== 'connected') this.closeAllForHost(e.hostId, 'conn-lost')
    })
  }

  open(opts: {
    hostId: string
    cols: number
    rows: number
    command?: string
  }): Promise<{ termId: string }> {
    const client = getConnectionManager().getClient(opts.hostId) // throws not-connected
    return new Promise((resolve, reject) => {
      client.shell({ term: 'xterm-256color', cols: opts.cols, rows: opts.rows }, (err, stream) => {
        if (err) {
          reject(new CodedError('conn-failed', `cannot open shell: ${err.message}`))
          return
        }
        const termId = newId('t_')
        const term: Term = {
          termId,
          hostId: opts.hostId,
          stream,
          chunks: [],
          buffered: 0,
          flushTimer: null,
          closed: false
        }
        this.terms.set(termId, term)

        stream.on('data', (chunk: Buffer) => this.push(term, chunk))
        stream.stderr.on('data', (chunk: Buffer) => this.push(term, chunk))
        stream.on('error', (chanErr: Error) => this.finish(term, 'error', chanErr.message))
        stream.on('close', () => this.finish(term, 'detach'))

        if (opts.command) stream.write(opts.command + '\n')
        resolve({ termId })
      })
    })
  }

  write(termId: string, data: Uint8Array): void {
    const term = this.terms.get(termId)
    if (!term || term.closed) return // terminal already gone; drop silently
    term.stream.write(Buffer.from(data))
  }

  resize(termId: string, cols: number, rows: number): void {
    const term = this.terms.get(termId)
    if (!term || term.closed) return
    term.stream.setWindow(rows, cols, 0, 0)
  }

  async close(termId: string): Promise<void> {
    const term = this.terms.get(termId)
    if (!term) return
    this.finish(term, 'closed')
  }

  /** Used on connection loss (reason "conn-lost") and app-level teardown. */
  closeAllForHost(hostId: string, reason: TermExitReason): void {
    for (const term of [...this.terms.values()]) {
      if (term.hostId === hostId) this.finish(term, reason)
    }
  }

  // ---------------- internals ----------------

  private push(term: Term, chunk: Buffer): void {
    if (term.closed) return
    term.chunks.push(chunk)
    term.buffered += chunk.length
    if (term.buffered >= FLUSH_THRESHOLD_BYTES) {
      this.flush(term)
    } else if (!term.flushTimer) {
      term.flushTimer = setTimeout(() => {
        term.flushTimer = null
        this.flush(term)
      }, FLUSH_INTERVAL_MS)
    }
  }

  private flush(term: Term): void {
    if (term.flushTimer) {
      clearTimeout(term.flushTimer)
      term.flushTimer = null
    }
    if (term.buffered === 0) return
    const data = Buffer.concat(term.chunks, term.buffered)
    term.chunks = []
    term.buffered = 0
    const event: TermDataEvent = { termId: term.termId, data: new Uint8Array(data) }
    this.emit('data', event)
  }

  private finish(term: Term, reason: TermExitReason, message?: string): void {
    if (term.closed) return
    term.closed = true
    this.flush(term)
    this.terms.delete(term.termId)
    try {
      term.stream.close()
    } catch {
      // channel may already be gone
    }
    const event: TermExitEvent = {
      termId: term.termId,
      reason,
      ...(message !== undefined ? { message } : {})
    }
    this.emit('exit', event)
  }
}

// ---------------- singleton ----------------

let service: TerminalService | null = null

/** Convenience accessor so the IPC layer shares one instance. */
export function getTerminalService(): TerminalService {
  if (!service) service = new TerminalService()
  return service
}
