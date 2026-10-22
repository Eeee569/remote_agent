import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Client } from 'ssh2'
import { execCommand } from './exec'

/**
 * Minimal stand-in for an ssh2 Client that models the thing this module
 * exists to survive: a server that only allows `limit` session channels at a
 * time and answers "open failed" beyond that.
 */
class FakeClient {
  open = 0
  peakOpen = 0
  attempts = 0
  refusals = 0

  constructor(
    private readonly limit: number,
    /** refuse this many opens before honouring any (simulates a busy server) */
    private readonly refuseFirst = 0
  ) {}

  exec(_command: string, cb: (err: Error | undefined, stream?: unknown) => void): void {
    this.attempts++
    if (this.refusals < this.refuseFirst || this.open >= this.limit) {
      this.refusals++
      setImmediate(() => cb(new Error('(SSH) Channel open failure: open failed')))
      return
    }
    this.open++
    this.peakOpen = Math.max(this.peakOpen, this.open)

    const stream = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter
      close(): void
      end(): void
    }
    stream.stderr = new EventEmitter()
    stream.close = () => undefined
    stream.end = () => undefined

    setImmediate(() => {
      cb(undefined, stream)
      setImmediate(() => {
        stream.emit('data', Buffer.from('ok'))
        stream.emit('exit', 0)
        this.open--
        stream.emit('close')
      })
    })
  }

  asClient(): Client {
    return this as unknown as Client
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('execCommand channel gating', () => {
  it('keeps concurrent channels within the gate, however many callers pile on', async () => {
    // the server would refuse a 4th channel; the gate must never ask for one
    const fake = new FakeClient(3)
    const client = fake.asClient()

    const results = await Promise.all(
      Array.from({ length: 12 }, () => execCommand(client, 'helper ls-tree'))
    )

    expect(results).toHaveLength(12)
    expect(results.every((r) => r.stdout === 'ok' && r.code === 0)).toBe(true)
    expect(fake.peakOpen).toBeLessThanOrEqual(3)
    expect(fake.refusals).toBe(0)
  })

  it('retries when the server refuses a channel it later grants', async () => {
    // two refusals up front — as if terminals held the budget momentarily
    const fake = new FakeClient(3, 2)
    const res = await execCommand(fake.asClient(), 'helper git-status')

    expect(res.stdout).toBe('ok')
    expect(fake.refusals).toBe(2)
    expect(fake.attempts).toBe(3)
  })

  it('gives up with an actionable error when the refusals never stop', async () => {
    vi.useFakeTimers()
    const fake = new FakeClient(0, Number.MAX_SAFE_INTEGER)
    const promise = execCommand(fake.asClient(), 'helper ls-tree')
    const assertion = expect(promise).rejects.toMatchObject({
      code: 'channel-limit',
      message: expect.stringContaining('MaxSessions')
    })
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
    // the initial attempt plus one per backoff step, then it stops
    expect(fake.attempts).toBe(5)
  })
})
