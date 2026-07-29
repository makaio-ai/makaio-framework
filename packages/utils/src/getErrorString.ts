/**
 * Reduce any thrown or reported failure to a short description.
 *
 * Accepts `unknown` because that is what a `catch` binding actually is, and
 * because every hand-rolled `err instanceof Error ? err.message : String(err)`
 * exists only for want of one shared version of this.
 *
 * Coercion is guarded: `String(value)` throws for a value with a null
 * prototype, a throwing `toString`, or a `Symbol.toPrimitive` that refuses —
 * and a describe-the-failure helper that itself throws replaces a diagnosable
 * failure with an undiagnosable one, in the handler that was meant to report
 * it.
 *
 * Falsy inputs — including `''`, `0`, and `false` — describe nothing, so they
 * are reported as `'Unknown error'` rather than as an empty or misleading
 * string.
 * @param error - Value to describe: an `Error`, a message, or anything a `catch` produced.
 * @returns The failure's message, its string form, or `'Unknown error'`.
 */
export function getErrorString(error: unknown): string {
  if (!error) {
    return 'Unknown error';
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    if (error instanceof Error) {
      return error.message ? String(error.message) : 'Unknown error';
    }
    return String(error) || 'Unknown error';
  } catch {
    return 'Unknown error';
  }
}
