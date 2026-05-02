const DEFAULT_PROBE_TIMEOUT_MS = 2_000;

/**
 * Health status returned by a running Makaio instance.
 *
 * Parsed from the `/health` response body. `auth` indicates whether
 * the bus WebSocket endpoint requires HMAC authentication.
 */
export interface HealthResult {
  /** Whether the bus requires HMAC authentication. */
  auth: boolean;
}

/**
 * Probe a running Makaio instance at the given URL.
 * @param url - Full URL of the `/health` endpoint (e.g. `http://127.0.0.1:6252/health`).
 * @param timeoutMs - Abort timeout in milliseconds (default 2000).
 * @returns Health result if the instance is alive and responding, `null` otherwise.
 */
export async function probeHealth(url: string, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<HealthResult | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return parseHealthBody(await res.text());
  } catch {
    return null;
  }
}

/**
 * Parse the raw `/health` response body.
 * @param body - Raw response text from the health endpoint.
 * @returns Parsed health result, or `null` if the body is not a valid health response.
 */
export function parseHealthBody(body: string): HealthResult | null {
  const trimmed = body.trim();
  if (trimmed.toLowerCase() === 'ok') return { auth: false };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'string') {
      return parsed.trim().toLowerCase() === 'ok' ? { auth: false } : null;
    }
    if (typeof parsed !== 'object' || parsed === null || !('ok' in parsed)) {
      return null;
    }
    const health = parsed as { ok?: unknown; auth?: unknown };
    return health.ok === true ? { auth: health.auth === true } : null;
  } catch {
    return null;
  }
}
