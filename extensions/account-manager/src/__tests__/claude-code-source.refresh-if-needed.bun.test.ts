/// <reference types="bun-types" />
import { describe, it, expect, mock, spyOn, jest, afterEach } from 'bun:test';
import type { RawCredential } from '../interfaces/credential-source.js';
import { ClaudeCodeSource } from '../sources/claude-code-source.js';
import { computeFingerprint } from '../utils/fingerprint.js';
import { InMemoryBackend } from './testing/in-memory-backend.js';
import { advanceTimersByTimeAsync } from '@makaio/test-utils';

/**
 * Builds a mock profile API response for the given account/org UUIDs.
 * @param opts - Profile field overrides.
 */
function _profileResponse(opts: {
  accountUuid?: string;
  orgUuid?: string;
  orgName?: string;
  email?: string;
}): Response {
  return new Response(
    JSON.stringify({
      account: {
        uuid: opts.accountUuid ?? 'acct-uuid-1',
        email: opts.email ?? 'user@example.com',
        full_name: 'Test User',
      },
      organization: {
        uuid: opts.orgUuid ?? 'org-uuid-1',
        name: opts.orgName ?? 'TestOrg',
      },
    }),
    { status: 200 },
  );
}

/**
 * Mocks fetch so aborting the provided signal rejects with AbortError.
 *
 * Shared by timeout tests to keep their fake-timer harness identical across
 * sources that use the same AbortController deadline pattern.
 */
function mockFetchAbortOnSignal(): void {
  spyOn(globalThis, 'fetch').mockImplementation(
    ((_url: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch,
  );
}

describe('ClaudeCodeSource', () => {
  afterEach(() => {
    mock.restore();
  });

  describe('refreshIfNeeded()', () => {
    /**
     * Builds a minimal RawCredential with the given token fields.
     * @param fields - Token payload fields to embed in the credential.
     */
    function makeCredential(fields: Record<string, unknown>): RawCredential {
      return {
        token: JSON.stringify(fields),
        fingerprint: 'fp',
        metadata: {},
      };
    }

    /**
     * Builds a mock token-endpoint response.
     * @param opts - Token response field overrides.
     */
    function tokenResponse(opts: { access_token?: string; refresh_token?: string; expires_in?: number }): Response {
      return new Response(
        JSON.stringify({
          access_token: opts.access_token ?? 'new-at',
          refresh_token: opts.refresh_token ?? 'new-rt',
          expires_in: opts.expires_in ?? 3600,
          token_type: 'Bearer',
        }),
        { status: 200 },
      );
    }

    it('returns unchanged when the token is not expired (beyond 5-minute buffer)', async () => {
      const source = new ClaudeCodeSource(new InMemoryBackend());
      const credential = makeCredential({
        refreshToken: 'rt',
        accessToken: 'at',
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes from now
      });

      await expect(source.refreshIfNeeded(credential)).resolves.toEqual({ status: 'unchanged' });
    });

    it('bypasses expiresAt guard and refreshes when force is true', async () => {
      spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        tokenResponse({ access_token: 'forced-at', refresh_token: 'forced-rt', expires_in: 3600 }),
      );
      const source = new ClaudeCodeSource(new InMemoryBackend());
      const credential = makeCredential({
        refreshToken: 'rt',
        accessToken: 'at',
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes from now — normally unchanged
      });

      const result = await source.refreshIfNeeded(credential, { force: true });

      expect(result.status).toBe('refreshed');
      if (result.status !== 'refreshed') throw new Error(`Expected refreshed, got ${result.status}`);
      expect(result.credential.fingerprint).toBe(computeFingerprint('forced-rt'));
      const parsed = JSON.parse(result.credential.token) as Record<string, unknown>;
      expect(parsed['accessToken']).toBe('forced-at');
      expect(parsed['refreshToken']).toBe('forced-rt');
    });

    it('returns unchanged when expiresAt is missing', async () => {
      const source = new ClaudeCodeSource(new InMemoryBackend());
      const credential = makeCredential({ refreshToken: 'rt', accessToken: 'at' });

      await expect(source.refreshIfNeeded(credential)).resolves.toEqual({ status: 'unchanged' });
    });

    it('returns unchanged when refreshToken is missing', async () => {
      const source = new ClaudeCodeSource(new InMemoryBackend());
      const credential = makeCredential({ accessToken: 'at', expiresAt: Date.now() - 1000 });

      await expect(source.refreshIfNeeded(credential)).resolves.toEqual({ status: 'unchanged' });
    });

    it('refreshes an expired token and returns updated credential', async () => {
      const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        tokenResponse({ access_token: 'fresh-at', refresh_token: 'fresh-rt', expires_in: 3600 }),
      );
      const source = new ClaudeCodeSource(new InMemoryBackend());
      const credential = makeCredential({
        refreshToken: 'old-rt',
        accessToken: 'old-at',
        expiresAt: Date.now() - 1000, // already expired
        subscriptionType: 'pro',
      });

      const result = await source.refreshIfNeeded(credential);

      expect(result.status).toBe('refreshed');
      if (result.status !== 'refreshed') {
        throw new Error(`Expected refreshed result, received ${result.status}`);
      }

      expect(result.credential.fingerprint).toBe(computeFingerprint('fresh-rt'));
      expect(result.credential.metadata).toMatchObject({ planType: 'pro' });
      const parsed = JSON.parse(result.credential.token) as Record<string, unknown>;
      expect(parsed['accessToken']).toBe('fresh-at');
      expect(parsed['refreshToken']).toBe('fresh-rt');
      expect(typeof parsed['expiresAt']).toBe('number');

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] ?? [];
      expect(url).toBe('https://platform.claude.com/v1/oauth/token');
      expect(init?.method).toBe('POST');
      const params = new URLSearchParams(String(init?.body));
      expect(params.get('grant_type')).toBe('refresh_token');
      expect(params.get('refresh_token')).toBe('old-rt');
      expect(params.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
      expect(params.get('scope')).toBe(
        'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload',
      );
    });

    it('preserves claudeAiOauth envelope when refreshing', async () => {
      spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        tokenResponse({ access_token: 'env-at', refresh_token: 'env-rt', expires_in: 7200 }),
      );
      const source = new ClaudeCodeSource(new InMemoryBackend());
      const credential = {
        token: JSON.stringify({
          claudeAiOauth: {
            refreshToken: 'old-env-rt',
            accessToken: 'old-env-at',
            expiresAt: Date.now() - 5000,
            subscriptionType: 'max',
          },
        }),
        fingerprint: 'fp',
        metadata: {},
      };

      const result = await source.refreshIfNeeded(credential);

      expect(result.status).toBe('refreshed');
      if (result.status !== 'refreshed') {
        throw new Error(`Expected refreshed result, received ${result.status}`);
      }

      const top = JSON.parse(result.credential.token) as Record<string, unknown>;
      // Envelope wrapper must be preserved
      expect(top).toHaveProperty('claudeAiOauth');
      const inner = top['claudeAiOauth'] as Record<string, unknown>;
      expect(inner['accessToken']).toBe('env-at');
      expect(inner['refreshToken']).toBe('env-rt');
      expect(typeof inner['expiresAt']).toBe('number');
      expect(result.credential.fingerprint).toBe(computeFingerprint('env-rt'));
      expect(result.credential.metadata).toMatchObject({ planType: 'max' });
    });

    it.each([
      400, 403, 401,
    ])('returns failed when the refresh endpoint returns HTTP %i (client error)', async (status) => {
      spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status }));
      const source = new ClaudeCodeSource(new InMemoryBackend());
      const credential = makeCredential({
        refreshToken: 'rt',
        accessToken: 'at',
        expiresAt: Date.now() - 1000,
      });

      await expect(source.refreshIfNeeded(credential)).resolves.toMatchObject({
        status: 'failed',
        reason: expect.stringContaining(`HTTP ${status}`),
      });
    });

    it.each([
      429, 500, 502, 503,
    ])('returns transient when the refresh endpoint returns retryable HTTP %i', async (status) => {
      spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status }));
      const source = new ClaudeCodeSource(new InMemoryBackend());
      const credential = makeCredential({
        refreshToken: 'rt',
        accessToken: 'at',
        expiresAt: Date.now() - 1000,
      });

      await expect(source.refreshIfNeeded(credential)).resolves.toMatchObject({
        status: 'transient',
        reason: expect.stringContaining(`HTTP ${status}`),
      });
    });

    it('returns transient when the refresh endpoint times out after 5 seconds', async () => {
      jest.useFakeTimers();
      try {
        mockFetchAbortOnSignal();
        const source = new ClaudeCodeSource(new InMemoryBackend());
        const credential = makeCredential({
          refreshToken: 'rt',
          accessToken: 'at',
          expiresAt: Date.now() - 1000,
        });

        let settled = false;
        const promise = source.refreshIfNeeded(credential).finally(() => {
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

    it('triggers refresh when token expires within the 5-minute buffer', async () => {
      spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        tokenResponse({ access_token: 'buffered-at', refresh_token: 'buffered-rt', expires_in: 3600 }),
      );
      const source = new ClaudeCodeSource(new InMemoryBackend());
      // 4 minutes out — within the 5-minute proactive buffer
      const credential = makeCredential({
        refreshToken: 'rt',
        accessToken: 'at',
        expiresAt: Date.now() + 4 * 60 * 1000,
      });

      const result = await source.refreshIfNeeded(credential);

      expect(result.status).toBe('refreshed');
      if (result.status !== 'refreshed') {
        throw new Error(`Expected refreshed result, received ${result.status}`);
      }
      expect(result.credential.fingerprint).toBe(computeFingerprint('buffered-rt'));
    });
  });
});
