import { randomBytes } from 'crypto'

/** Returns `prefix` + 12 hex chars, e.g. newId('h_') -> 'h_a1b2c3d4e5f6'. */
export function newId(prefix: string): string {
  return prefix + randomBytes(6).toString('hex')
}
