import type { CredentialRefreshResult } from '../interfaces/credential-source.js';
import { fetchWithTimeout } from './fetch-with-timeout.js';

/** Default fetch timeout in milliseconds for OAuth token requests. */
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Discriminated union representing every possible outcome of an OAuth token
 * HTTP round-trip.
 *
 * - `ok` — the server replied 200 and the body parsed as JSON.
 * - `failed` — a 4xx response (excluding 408 and 429) definitively rejected
 *   the request; the credential should be discarded.
 * - `transient` — a network error, timeout abort, 408, 429, or 5xx response
 *   indicates a temporary problem; the credential may still be valid.
 */
export type OAuthTokenResult =
  | { status: 'ok'; data: Record<string, unknown> }
  | { status: 'failed'; reason: string }
  | { status: 'transient'; reason: string };

/**
 * Options accepted by {@link performOAuthTokenRequest}.
 */
export interface OAuthTokenRequestOptions {
  /**
   * Maximum milliseconds to wait before aborting the fetch.
   * @defaultValue 5000
   */
  timeoutMs?: number;
}

/**
 * Performs a single OAuth token POST request with a deadline-based abort and
 * uniform status-code bucketing.
 *
 * The function owns the full HTTP round-trip:
 * - Creates an `AbortController` and cancels the request after `timeoutMs`.
 * - POSTs `body` as `application/x-www-form-urlencoded`.
 * - Maps HTTP status codes to the {@link OAuthTokenResult} discriminant:
 * - 408, 429, or ≥ 500 → `transient` (server/transport or rate-limit problem).
 * - Other non-ok → `failed` (client error; credential is likely invalid).
 * - 200 OK → `ok` with the parsed JSON payload.
 * - Catches network-level errors (timeout abort, DNS failure, connection
 * refused) and returns them as `transient`.
 * @param endpoint - The full URL of the OAuth token endpoint.
 * @param body - URL-encoded request parameters (e.g. grant_type, client_id).
 * @param options - Optional configuration; see {@link OAuthTokenRequestOptions}.
 * @returns A promise that always resolves to an {@link OAuthTokenResult}.
 */
export async function performOAuthTokenRequest(
  endpoint: string,
  body: URLSearchParams,
  options?: OAuthTokenRequestOptions,
): Promise<OAuthTokenResult> {
  const raw = options?.timeoutMs;
  const timeoutMs = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;

  try {
    const response = await fetchWithTimeout(
      endpoint,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
      timeoutMs,
    );

    if (!response.ok) {
      const reason = `OAuth token request failed with HTTP ${response.status} ${response.statusText}`;
      return response.status === 408 || response.status === 429 || response.status >= 500
        ? { status: 'transient', reason }
        : { status: 'failed', reason };
    }

    const data: unknown = await response.json();
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      return { status: 'transient', reason: 'OAuth token response returned a non-object JSON payload' };
    }
    return { status: 'ok', data: data as Record<string, unknown> };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { status: 'transient', reason };
  }
}

/**
 * Maps a non-ok {@link OAuthTokenResult} to a {@link CredentialRefreshResult},
 * logging permanent failures with a caller-supplied context label.
 *
 * Only accepts the non-ok variants (`failed` | `transient`). Callers must
 * narrow to `result.status !== 'ok'` before calling this helper.
 * Transient results are not logged at `console.error` level because they are
 * retryable (429, 5xx, timeout, network errors) and logging every retry cycle
 * as an error would be misleading.
 * @param result - A failed or transient token-request outcome.
 * @param context - Human-readable label for log messages (e.g. `"Codex OAuth token exchange"`).
 * @returns A `failed` or `transient` refresh result.
 */
export function mapOAuthErrorToRefreshResult(
  result: { status: 'failed' | 'transient'; reason: string },
  context: string,
): CredentialRefreshResult {
  if (result.status === 'failed') {
    console.error(`[${context}] ${new Date().toISOString()} — ${result.reason}`);
  }
  const qualifier = result.status === 'transient' ? 'transient error' : 'failed';
  return { status: result.status, reason: `${context} ${qualifier}: ${result.reason}` };
}
