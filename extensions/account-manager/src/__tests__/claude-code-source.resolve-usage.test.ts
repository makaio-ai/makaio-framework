import { describe, it, expect, vi, afterEach } from 'vitest';
import type { RawCredential } from '../interfaces/credential-source.js';
import { RateLimitedError, UsageAuthInvalidError } from '../interfaces/usage-provider.js';
import { ClaudeCodeSource } from '../sources/claude-code-source.js';
import { computeFingerprint } from '../utils/fingerprint.js';
import { InMemoryBackend } from './testing/in-memory-backend.js';
import { mockFetchAbortOnSignal } from './testing/fetch-abort.js';

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

describe('ClaudeCodeSource', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('resolveUsage()', () => {
    /**
     * Builds a fresh source/backend pair plus the RawCredential under test.
     * Keeping this local avoids repeating the resolveUsage fixture plumbing
     * across many scenarios while leaving each case explicit about token shape.
     * @param tokenFields - JSON payload to embed in the credential token.
     * @param fingerprint - Optional fingerprint override for the credential.
     */
    function makeResolveUsageContext(
      tokenFields: Record<string, unknown>,
      fingerprint = 'fp',
    ): {
      backend: InMemoryBackend;
      source: ClaudeCodeSource;
      credential: RawCredential;
    } {
      const backend = new InMemoryBackend();
      return {
        backend,
        source: new ClaudeCodeSource(backend),
        credential: {
          token: JSON.stringify(tokenFields),
          fingerprint,
          metadata: {},
        },
      };
    }

    it('throws UsageAuthInvalidError when token has no accessToken field', async () => {
      const { source, credential } = makeResolveUsageContext({ refreshToken: 'tok' }, computeFingerprint('tok'));

      await expect(source.resolveUsage(credential)).rejects.toBeInstanceOf(UsageAuthInvalidError);
    });

    it('throws UsageAuthInvalidError when claudeAiOauth envelope has no accessToken', async () => {
      const { source, credential } = makeResolveUsageContext(
        { claudeAiOauth: { refreshToken: 'tok' } },
        computeFingerprint('tok'),
      );

      await expect(source.resolveUsage(credential)).rejects.toBeInstanceOf(UsageAuthInvalidError);
    });

    it('returns null when the fetch fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network error'));
      const { source, credential } = makeResolveUsageContext({ accessToken: 'at-valid' });

      await expect(source.resolveUsage(credential)).resolves.toBeNull();
    });

    it('throws UsageAuthInvalidError when response is unauthorized', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 401 }));
      const { source, credential } = makeResolveUsageContext({ accessToken: 'at-valid' });

      await expect(source.resolveUsage(credential)).rejects.toBeInstanceOf(UsageAuthInvalidError);
    });

    it('throws UsageAuthInvalidError when response is forbidden', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 403 }));
      const { source, credential } = makeResolveUsageContext({ accessToken: 'at-valid' });

      await expect(source.resolveUsage(credential)).rejects.toBeInstanceOf(UsageAuthInvalidError);
    });

    it('returns null when response is a non-auth error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 500 }));
      const { source, credential } = makeResolveUsageContext({ accessToken: 'at-valid' });

      await expect(source.resolveUsage(credential)).resolves.toBeNull();
    });

    it('parses Retry-After HTTP-date values before applying the backoff floor', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-04-20T10:00:00.000Z'));
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
          new Response(null, {
            status: 429,
            headers: {
              'Retry-After': new Date(Date.now() + 180_000).toUTCString(),
            },
          }),
        );
        const { source, credential } = makeResolveUsageContext({ accessToken: 'at-valid' });

        let thrown: unknown;
        try {
          await source.resolveUsage(credential);
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(RateLimitedError);
        expect(thrown).toMatchObject({ retryAfterMs: 180_000 });
      } finally {
        vi.useRealTimers();
      }
    });

    it('ignores malformed Retry-After values and falls back to the backoff floor', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: {
            'Retry-After': '120seconds',
          },
        }),
      );
      const { source, credential } = makeResolveUsageContext({ accessToken: 'at-valid' });

      let thrown: unknown;
      try {
        await source.resolveUsage(credential);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(RateLimitedError);
      expect(thrown).toMatchObject({ retryAfterMs: 60_000 });
    });

    it('keeps the 429 backoff streak until a successful usage response clears it', async () => {
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(null, { status: 429 }))
        .mockResolvedValueOnce(new Response(null, { status: 500 }))
        .mockResolvedValueOnce(new Response(null, { status: 429 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              five_hour: { utilization: 10, resets_at: new Date(Date.now() + 3600_000).toISOString() },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 429 }));

      const { source, credential } = makeResolveUsageContext({ accessToken: 'at-valid' });

      await expect(source.resolveUsage(credential)).rejects.toMatchObject({ retryAfterMs: 60_000 });
      await expect(source.resolveUsage(credential)).resolves.toBeNull();
      await expect(source.resolveUsage(credential)).rejects.toMatchObject({ retryAfterMs: 120_000 });
      await expect(source.resolveUsage(credential)).resolves.toMatchObject({
        usage: expect.objectContaining({ blocked: false }),
      });
      await expect(source.resolveUsage(credential)).rejects.toMatchObject({ retryAfterMs: 60_000 });
    });

    it('maps five_hour and seven_day windows with correct ids, labels, groups, and windowSeconds', async () => {
      const now = Date.now();
      const resetsAtIso = new Date(now + 3600_000).toISOString();
      const apiResponse = {
        five_hour: { utilization: 50, resets_at: resetsAtIso },
        seven_day: { utilization: 10, resets_at: resetsAtIso },
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(apiResponse), { status: 200 }));
      const backend = new InMemoryBackend();
      const source = new ClaudeCodeSource(backend);
      const credential = {
        token: JSON.stringify({ accessToken: 'at-valid' }),
        fingerprint: 'fp',
        metadata: {},
      };

      const result = await source.resolveUsage(credential);

      expect(result).not.toBeNull();
      expect(result!.usage.windows).toHaveLength(2);
      expect(result!.usage.windows[0]).toMatchObject({
        id: '5h',
        label: '5 Hour',
        group: 'overall',
        windowSeconds: 18000,
      });
      expect(result!.usage.windows[1]).toMatchObject({
        id: '7d',
        label: '7 Day',
        group: 'overall',
        windowSeconds: 604800,
      });
    });

    it('maps seven_day_sonnet window with correct id, label, and group', async () => {
      const resetsAtIso = new Date(Date.now() + 86400_000).toISOString();
      const apiResponse = {
        seven_day_sonnet: { utilization: 80, resets_at: resetsAtIso },
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(apiResponse), { status: 200 }));
      const backend = new InMemoryBackend();
      const source = new ClaudeCodeSource(backend);
      const credential = {
        token: JSON.stringify({ accessToken: 'at-valid' }),
        fingerprint: 'fp',
        metadata: {},
      };

      const result = await source.resolveUsage(credential);

      expect(result).not.toBeNull();
      expect(result!.usage.windows).toHaveLength(1);
      expect(result!.usage.windows[0]).toMatchObject({
        id: '7d-sonnet',
        label: 'Sonnet (7 Day)',
        group: 'model',
        windowSeconds: 604800,
      });
    });

    it('warns when the usage endpoint succeeds but returns no known usage windows', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            extra_usage: {
              is_enabled: true,
              balance: '$4.20',
            },
            unexpected_key: { value: 1 },
          }),
          { status: 200 },
        ),
      );
      const { source, credential } = makeResolveUsageContext({ accessToken: 'at-valid' });

      const result = await source.resolveUsage(credential);

      expect(result).not.toBeNull();
      expect(result!.usage.windows).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        '[ClaudeCodeSource] usage endpoint returned no known windows; response keys: extra_usage, unexpected_key',
      );
    });

    it('sets blocked to true when any window has utilization >= 100', async () => {
      const resetsAtIso = new Date(Date.now() + 3600_000).toISOString();
      const apiResponse = {
        five_hour: { utilization: 100, resets_at: resetsAtIso },
        seven_day: { utilization: 20, resets_at: resetsAtIso },
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(apiResponse), { status: 200 }));
      const backend = new InMemoryBackend();
      const source = new ClaudeCodeSource(backend);
      const credential = {
        token: JSON.stringify({ accessToken: 'at-valid' }),
        fingerprint: 'fp',
        metadata: {},
      };

      const result = await source.resolveUsage(credential);

      expect(result).not.toBeNull();
      expect(result!.usage.blocked).toBe(true);
    });

    it('sets blocked to false when no window has utilization >= 100', async () => {
      const resetsAtIso = new Date(Date.now() + 3600_000).toISOString();
      const apiResponse = {
        five_hour: { utilization: 99, resets_at: resetsAtIso },
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(apiResponse), { status: 200 }));
      const backend = new InMemoryBackend();
      const source = new ClaudeCodeSource(backend);
      const credential = {
        token: JSON.stringify({ accessToken: 'at-valid' }),
        fingerprint: 'fp',
        metadata: {},
      };

      const result = await source.resolveUsage(credential);

      expect(result).not.toBeNull();
      expect(result!.usage.blocked).toBe(false);
    });

    it('maps extra_usage to credits when present', async () => {
      const resetsAtIso = new Date(Date.now() + 3600_000).toISOString();
      const apiResponse = {
        five_hour: { utilization: 10, resets_at: resetsAtIso },
        extra_usage: {
          is_enabled: true,
          balance: '$4.20',
          monthly_limit: '$25.00',
          utilization: 17,
        },
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(apiResponse), { status: 200 }));
      const backend = new InMemoryBackend();
      const source = new ClaudeCodeSource(backend);
      const credential = {
        token: JSON.stringify({ accessToken: 'at-valid' }),
        fingerprint: 'fp',
        metadata: {},
      };

      const result = await source.resolveUsage(credential);

      expect(result).not.toBeNull();
      expect(result!.usage.credits).toMatchObject({
        enabled: true,
        balance: '$4.20',
        limit: '$25.00',
        utilization: 17,
      });
    });

    it('accepts legacy resetsAt usage windows for compatibility', async () => {
      const resetsAtIso = new Date(Date.now() + 3600_000).toISOString();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 10, resetsAt: resetsAtIso },
          }),
          { status: 200 },
        ),
      );
      const backend = new InMemoryBackend();
      const source = new ClaudeCodeSource(backend);
      const credential = {
        token: JSON.stringify({ accessToken: 'at-valid' }),
        fingerprint: 'fp',
        metadata: {},
      };

      const result = await source.resolveUsage(credential);

      expect(result).not.toBeNull();
      expect(result!.usage.windows).toHaveLength(1);
      expect(result!.usage.windows[0].resetsAt).toBe(new Date(resetsAtIso).getTime());
    });

    it('unwraps claudeAiOauth envelope to extract accessToken', async () => {
      const resetsAtIso = new Date(Date.now() + 3600_000).toISOString();
      const apiResponse = {
        five_hour: { utilization: 30, resets_at: resetsAtIso },
      };
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(JSON.stringify(apiResponse), { status: 200 }));
      const backend = new InMemoryBackend();
      const source = new ClaudeCodeSource(backend);
      const credential = {
        token: JSON.stringify({ claudeAiOauth: { accessToken: 'at-enveloped', refreshToken: 'rt' } }),
        fingerprint: computeFingerprint('rt'),
        metadata: {},
      };

      const result = await source.resolveUsage(credential);

      expect(result).not.toBeNull();
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.anthropic.com/api/oauth/usage',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer at-enveloped',
            'anthropic-beta': 'oauth-2025-04-20',
          }),
        }),
      );
    });

    it('returns null when the fetch times out after 3 seconds', async () => {
      vi.useFakeTimers();
      try {
        mockFetchAbortOnSignal();
        const backend = new InMemoryBackend();
        const source = new ClaudeCodeSource(backend);
        const credential = {
          token: JSON.stringify({ accessToken: 'at-valid' }),
          fingerprint: 'fp',
          metadata: {},
        };

        let settled = false;
        const promise = source.resolveUsage(credential).finally(() => {
          settled = true;
        });

        await vi.advanceTimersByTimeAsync(2999);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await expect(promise).resolves.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
