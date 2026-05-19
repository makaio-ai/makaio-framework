/// <reference types="bun-types" />
import { describe, it, expect, afterEach, jest, spyOn, mock } from 'bun:test';
import { advanceTimersByTimeAsync } from '@makaio/test-utils';
import { performOAuthTokenRequest } from '../utils/oauth-token-request.js';

const TEST_ENDPOINT = 'https://example.com/oauth/token';

/**
 * Builds a mock Response with JSON body and the given HTTP status.
 * @param data - The object to serialize as the response body.
 * @param status - HTTP status code for the response.
 */
function jsonResponse(data: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Mocks fetch so aborting the provided signal rejects with AbortError.
 *
 * Bun-compatible version using spyOn from bun:test.
 */
function mockFetchAbortOnSignal(): void {
  spyOn(globalThis, 'fetch').mockImplementation(
    ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch,
  );
}

describe('performOAuthTokenRequest', () => {
  afterEach(() => {
    mock.restore();
  });

  it('returns { status: "ok", data } for a 200 response', async () => {
    const payload = { access_token: 'at', refresh_token: 'rt', expires_in: 3600 };
    spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(payload));

    const body = new URLSearchParams({ grant_type: 'refresh_token' });
    const result = await performOAuthTokenRequest(TEST_ENDPOINT, body);

    expect(result).toEqual({ status: 'ok', data: payload });
  });

  it('returns { status: "failed" } with reason containing "400" for HTTP 400', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 400 }));

    const result = await performOAuthTokenRequest(TEST_ENDPOINT, new URLSearchParams());

    expect(result).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('400'),
    });
  });

  it('returns { status: "failed" } with reason containing "401" for HTTP 401', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 401 }));

    const result = await performOAuthTokenRequest(TEST_ENDPOINT, new URLSearchParams());

    expect(result).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('401'),
    });
  });

  it('returns { status: "failed" } with reason containing "403" for HTTP 403', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 403 }));

    const result = await performOAuthTokenRequest(TEST_ENDPOINT, new URLSearchParams());

    expect(result).toMatchObject({
      status: 'failed',
      reason: expect.stringContaining('403'),
    });
  });

  it('returns { status: "transient" } with reason containing "408" for HTTP 408', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 408 }));

    const result = await performOAuthTokenRequest(TEST_ENDPOINT, new URLSearchParams());

    expect(result).toMatchObject({
      status: 'transient',
      reason: expect.stringContaining('408'),
    });
  });

  it('returns { status: "transient" } with reason containing "429" for HTTP 429', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 429 }));

    const result = await performOAuthTokenRequest(TEST_ENDPOINT, new URLSearchParams());

    expect(result).toMatchObject({
      status: 'transient',
      reason: expect.stringContaining('429'),
    });
  });

  it('returns { status: "transient" } with reason containing "500" for HTTP 500', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 500 }));

    const result = await performOAuthTokenRequest(TEST_ENDPOINT, new URLSearchParams());

    expect(result).toMatchObject({
      status: 'transient',
      reason: expect.stringContaining('500'),
    });
  });

  it('returns { status: "transient" } with reason containing "502" for HTTP 502', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 502 }));

    const result = await performOAuthTokenRequest(TEST_ENDPOINT, new URLSearchParams());

    expect(result).toMatchObject({
      status: 'transient',
      reason: expect.stringContaining('502'),
    });
  });

  it('returns { status: "transient" } with reason containing "503" for HTTP 503', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 503 }));

    const result = await performOAuthTokenRequest(TEST_ENDPOINT, new URLSearchParams());

    expect(result).toMatchObject({
      status: 'transient',
      reason: expect.stringContaining('503'),
    });
  });

  it('returns { status: "transient", reason matching /abort/i } when the default 5s timeout fires', async () => {
    jest.useFakeTimers();
    try {
      mockFetchAbortOnSignal();

      let settled = false;
      const promise = performOAuthTokenRequest(TEST_ENDPOINT, new URLSearchParams()).finally(() => {
        settled = true;
      });

      await advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);

      await advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toMatchObject({
        status: 'transient',
        reason: expect.stringMatching(/abort/i),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns { status: "transient" } with error message on network error', async () => {
    spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network unreachable'));

    const result = await performOAuthTokenRequest(TEST_ENDPOINT, new URLSearchParams());

    expect(result).toMatchObject({
      status: 'transient',
      reason: expect.stringContaining('network unreachable'),
    });
  });

  it('honors a custom timeoutMs option', async () => {
    jest.useFakeTimers();
    try {
      mockFetchAbortOnSignal();

      let settled = false;
      const promise = performOAuthTokenRequest(TEST_ENDPOINT, new URLSearchParams(), {
        timeoutMs: 1000,
      }).finally(() => {
        settled = true;
      });

      await advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);

      await advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toMatchObject({
        status: 'transient',
        reason: expect.stringMatching(/abort/i),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    0,
    -1,
    NaN,
    Infinity,
    -Infinity,
  ])('falls back to the default 5s timeout when timeoutMs is %s', async (invalidTimeout) => {
    jest.useFakeTimers();
    try {
      mockFetchAbortOnSignal();

      let settled = false;
      const promise = performOAuthTokenRequest(TEST_ENDPOINT, new URLSearchParams(), {
        timeoutMs: invalidTimeout,
      }).finally(() => {
        settled = true;
      });

      await advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);

      await advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toMatchObject({
        status: 'transient',
        reason: expect.stringMatching(/abort/i),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns { status: "transient" } when 200 body is a non-object JSON value', async () => {
    spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify(null), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );

    const result = await performOAuthTokenRequest(TEST_ENDPOINT, new URLSearchParams());

    expect(result).toMatchObject({
      status: 'transient',
      reason: expect.stringContaining('non-object'),
    });
  });

  it('sends POST with explicit Content-Type and the URLSearchParams body', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ access_token: 'at' }));

    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: 'client-123' });
    await performOAuthTokenRequest(TEST_ENDPOINT, body);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe(TEST_ENDPOINT);
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)?.['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init?.body).toBe(body);
  });
});
