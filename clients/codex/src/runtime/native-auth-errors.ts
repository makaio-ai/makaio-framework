/**
 * Secret-safe error helpers for Codex native authentication storage.
 * @packageDocumentation
 */

/**
 * Build an error that preserves a safe discriminator but never the secret-bearing message.
 * @param operation - Safe operation label.
 * @param error - Original failure, whose message is deliberately discarded.
 * @returns Sanitized error safe for bus propagation and logs.
 */
export function sanitizedNativeAuthError(operation: string, error: unknown): Error {
  const errorName = error instanceof Error && error.name ? error.name : 'UnknownError';
  const code = (error as { code?: unknown } | null)?.code;
  const safeCode = typeof code === 'string' || typeof code === 'number' ? `/${String(code)}` : '';
  return new Error(`Codex native-auth ${operation} failed (${errorName}${safeCode})`);
}

/**
 * Preserve both sanitized failures when cleanup follows an earlier error.
 * @param existing - Earlier failure, when present.
 * @param next - Newly observed sanitized failure.
 * @param message - Safe aggregate description.
 * @returns The new failure or an aggregate retaining both failures.
 */
export function mergeNativeAuthErrors(existing: unknown, next: Error, message: string): unknown {
  return existing === undefined ? next : new AggregateError([existing, next], message);
}
