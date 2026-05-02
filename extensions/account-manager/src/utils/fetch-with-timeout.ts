/**
 * Performs a `fetch` request with a deadline-based abort.
 *
 * Creates an `AbortController`, schedules an abort after `timeoutMs`, and
 * guarantees cleanup in `finally`. The caller owns all status-code and
 * error-handling logic — this helper only manages the timeout lifecycle.
 * @param input - URL or Request to fetch.
 * @param init - Standard fetch init (headers, method, body, etc.). An
 *   `AbortSignal` on `init` is replaced by the timeout-managed signal.
 * @param timeoutMs - Maximum milliseconds before the request is aborted.
 * @returns The `Response` from the underlying `fetch` call.
 */
export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}
