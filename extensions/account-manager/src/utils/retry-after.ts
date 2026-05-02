/**
 * Parses an HTTP `Retry-After` header into a finite, non-negative delay.
 *
 * Accepts RFC-compliant delta-seconds and HTTP-date values. Rejects malformed
 * numeric prefixes such as `120junk` so bad headers cannot accidentally
 * lengthen cooldowns beyond the source's fallback policy.
 * @param headerValue - Raw header value, if present
 * @param nowMs - Current wall-clock time in ms for HTTP-date deltas
 * @returns Parsed delay in ms, or 0 when the header is absent/invalid
 */
export function parseRetryAfterMs(headerValue: string | null, nowMs: number): number {
  if (headerValue === null) return 0;

  const value = headerValue.trim();
  if (value.length === 0) return 0;

  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    return Number.isSafeInteger(seconds) ? seconds * 1000 : 0;
  }

  const retryAtMs = Date.parse(value);
  if (!Number.isFinite(retryAtMs)) return 0;
  return Math.max(0, retryAtMs - nowMs);
}
