/**
 * Typed error carried across main-process module boundaries and serialized
 * over IPC as { name, message, code }.
 *
 * Codes in use: not-connected, auth-failed, hostkey-mismatch, conn-failed,
 * channel-limit, timeout, sftp-failed, not-found, encryption-unavailable,
 * too-large.
 */
export class CodedError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'CodedError'
  }
}
