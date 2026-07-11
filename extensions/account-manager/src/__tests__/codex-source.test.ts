import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { FileBackend } from '../backends/file-backend.js';
import { RateLimitedError, UsageAuthInvalidError } from '../interfaces/usage-provider.js';
import { CodexSource } from '../sources/codex-source.js';
import { parseUsageWindow } from '../sources/codex-usage-parser.js';
import { computeFingerprint } from '../utils/fingerprint.js';
import { InMemoryBackend } from './testing/in-memory-backend.js';
import { mockFetchAbortOnSignal } from './testing/fetch-abort.js';

/**
 * Encodes a JSON payload as a base64url string suitable for a JWT segment.
 * @param payload - The object to encode
 * @returns base64url-encoded JSON string
 */
function encodeJwtPayload(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
}

/**
 * Creates a fake (unsigned) JWT with a given payload.
 * @param payload - The payload to embed
 * @returns A three-segment JWT string with a dummy header and empty signature
 */
function makeFakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  return `${header}.${encodeJwtPayload(payload)}.fakesig`;
}

describe('CodexSource', () => {
  describe('read() — common', () => {
    it('returns null when backend is empty', async () => {
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);

      const result = await source.read();

      expect(result).toBeNull();
    });

    it('returns null for invalid JSON', async () => {
      const backend = new InMemoryBackend();
      backend.set('not-valid-json{{');
      const source = new CodexSource(backend);

      const result = await source.read();

      expect(result).toBeNull();
    });

    it('rethrows backend read failures instead of treating them as no credential', async () => {
      const root = await mkdtemp(join(tmpdir(), 'codex-source-'));
      const codexHome = join(root, '.codex');

      try {
        await mkdir(codexHome, { recursive: true });
        const source = new CodexSource(new FileBackend(codexHome), {
          codexHome,
        });

        await expect(source.read()).rejects.toMatchObject({ code: 'EISDIR' });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('read() — chatgpt mode (default)', () => {
    it('parses credential using account_id as fingerprint', async () => {
      const backend = new InMemoryBackend();
      const raw = JSON.stringify({
        tokens: { account_id: 'acct-uuid-1234' },
      });
      backend.set(raw);
      const source = new CodexSource(backend);

      const result = await source.read();

      expect(result).not.toBeNull();
      expect(result!.token).toBe(raw);
      expect(result!.fingerprint).toBe('acct-uuid-1234');
    });

    it('returns null when account_id is missing', async () => {
      const backend = new InMemoryBackend();
      backend.set(JSON.stringify({ tokens: { access_token: 'some-token' } }));
      const source = new CodexSource(backend);

      const result = await source.read();

      expect(result).toBeNull();
    });

    it('extracts planType from id_token JWT', async () => {
      const idToken = makeFakeJwt({
        sub: 'user-123',
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'plus',
        },
      });
      const backend = new InMemoryBackend();
      backend.set(
        JSON.stringify({
          tokens: {
            account_id: 'acct-uuid-5678',
            id_token: idToken,
          },
        }),
      );
      const source = new CodexSource(backend);

      const result = await source.read();

      expect(result).not.toBeNull();
      expect(result!.metadata).toMatchObject({
        authMode: 'chatgpt',
        accountId: 'acct-uuid-5678',
        planType: 'plus',
      });
    });

    it('omits non-string planType from id_token JWT metadata', async () => {
      const idToken = makeFakeJwt({
        sub: 'user-123',
        'https://api.openai.com/auth': {
          chatgpt_plan_type: { tier: 'plus' },
        },
      });
      const backend = new InMemoryBackend();
      backend.set(
        JSON.stringify({
          tokens: {
            account_id: 'acct-uuid-5678',
            id_token: idToken,
          },
        }),
      );
      const source = new CodexSource(backend);

      const result = await source.read();

      expect(result).not.toBeNull();
      expect(result!.metadata).not.toHaveProperty('planType');
    });

    it('does not extract name/email when id_token chatgpt_account_id mismatches tokens.account_id', async () => {
      const idToken = makeFakeJwt({
        sub: 'different-user-id',
        name: 'Wrong User',
        email: 'wrong@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct-different-org',
          chatgpt_plan_type: 'plus',
        },
      });
      const backend = new InMemoryBackend();
      backend.set(
        JSON.stringify({
          tokens: {
            account_id: 'acct-real-user',
            id_token: idToken,
          },
        }),
      );
      const source = new CodexSource(backend);

      const result = await source.read();

      expect(result).not.toBeNull();
      // planType is account-scoped and still extracted despite the mismatch.
      expect(result!.metadata.planType).toBe('plus');
      // name and email must NOT be extracted when the subject does not match.
      expect(result!.metadata.name).toBeUndefined();
      expect(result!.metadata.email).toBeUndefined();
    });
  });

  describe('read() — apikey mode', () => {
    it('uses computeFingerprint of the API key as fingerprint', async () => {
      const apiKey = 'sk-test-api-key-12345';
      const backend = new InMemoryBackend();
      backend.set(
        JSON.stringify({
          auth_mode: 'apikey',
          OPENAI_API_KEY: apiKey,
        }),
      );
      const source = new CodexSource(backend);

      const result = await source.read();

      expect(result).not.toBeNull();
      expect(result!.fingerprint).toBe(computeFingerprint(apiKey));
      expect(result!.metadata).toMatchObject({ authMode: 'apikey', apiProvider: 'openai' });
    });

    it('returns null when API key is missing', async () => {
      const backend = new InMemoryBackend();
      backend.set(JSON.stringify({ auth_mode: 'apikey' }));
      const source = new CodexSource(backend);

      const result = await source.read();

      expect(result).toBeNull();
    });

    it('returns null when API key is an empty string', async () => {
      const backend = new InMemoryBackend();
      backend.set(JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: '' }));
      const source = new CodexSource(backend);

      const result = await source.read();

      expect(result).toBeNull();
    });
  });

  describe('write()', () => {
    it('delegates the token to the backend', async () => {
      const root = await mkdtemp(join(await realpath(tmpdir()), 'codex-source-'));
      const codexHome = join(root, '.codex');
      await mkdir(codexHome, { recursive: true });
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend, { codexHome });
      const token = JSON.stringify({
        tokens: { account_id: 'acct-abc' },
      });
      const credential = {
        token,
        fingerprint: 'acct-abc',
        metadata: { authMode: 'chatgpt' },
      };

      try {
        await source.write(credential);
        expect(await backend.read()).toBe(token);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('resolveUsage()', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('throws UsageAuthInvalidError for apikey mode', async () => {
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const credential = {
        token: JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-abc' }),
        fingerprint: computeFingerprint('sk-abc'),
        metadata: { authMode: 'apikey', apiProvider: 'openai' },
      };

      await expect(source.resolveUsage(credential)).rejects.toBeInstanceOf(UsageAuthInvalidError);
    });

    it('throws UsageAuthInvalidError when access_token is absent in chatgpt mode', async () => {
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const credential = {
        token: JSON.stringify({ tokens: { account_id: 'acct-1' } }),
        fingerprint: 'acct-1',
        metadata: {},
      };

      await expect(source.resolveUsage(credential)).rejects.toBeInstanceOf(UsageAuthInvalidError);
    });

    it('returns null when the fetch fails', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network error'));
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const credential = {
        token: JSON.stringify({ tokens: { account_id: 'acct-1', access_token: 'at-tok' } }),
        fingerprint: 'acct-1',
        metadata: {},
      };

      await expect(source.resolveUsage(credential)).resolves.toBeNull();
    });

    it.each([401, 403])('throws UsageAuthInvalidError when response is unauthorized (HTTP %i)', async (status) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status }));
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const credential = {
        token: JSON.stringify({ tokens: { account_id: 'acct-1', access_token: 'at-tok' } }),
        fingerprint: 'acct-1',
        metadata: {},
      };

      await expect(source.resolveUsage(credential)).rejects.toBeInstanceOf(UsageAuthInvalidError);
    });

    it('uses Retry-After when response is rate-limited', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: {
            'Retry-After': '120',
          },
        }),
      );
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const credential = {
        token: JSON.stringify({ tokens: { account_id: 'acct-1', access_token: 'at-tok' } }),
        fingerprint: 'acct-1',
        metadata: {},
      };

      const promise = source.resolveUsage(credential);
      await expect(promise).rejects.toBeInstanceOf(RateLimitedError);
      await expect(promise).rejects.toMatchObject({ retryAfterMs: 120_000 });
    });

    it('returns null when response is a non-auth error', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 500 }));
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const credential = {
        token: JSON.stringify({ tokens: { account_id: 'acct-1', access_token: 'at-tok' } }),
        fingerprint: 'acct-1',
        metadata: {},
      };

      await expect(source.resolveUsage(credential)).resolves.toBeNull();
    });

    it('maps primary_window and secondary_window with correct ids, labels, groups, and windowSeconds', async () => {
      const apiResponse = {
        rate_limit: {
          primary_window: { used_percent: 40, reset_after_seconds: 3600, limit_window_seconds: 18000 },
          secondary_window: { used_percent: 5, reset_after_seconds: 86400, limit_window_seconds: 604800 },
          limit_reached: false,
        },
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(apiResponse), { status: 200 }));
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const credential = {
        token: JSON.stringify({ tokens: { account_id: 'acct-1', access_token: 'at-tok' } }),
        fingerprint: 'acct-1',
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

    it('sets blocked to true when limit_reached is true', async () => {
      const apiResponse = {
        rate_limit: {
          primary_window: { used_percent: 100, reset_after_seconds: 1800, limit_window_seconds: 18000 },
          limit_reached: true,
        },
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(apiResponse), { status: 200 }));
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const credential = {
        token: JSON.stringify({ tokens: { account_id: 'acct-1', access_token: 'at-tok' } }),
        fingerprint: 'acct-1',
        metadata: {},
      };

      const result = await source.resolveUsage(credential);

      expect(result).not.toBeNull();
      expect(result!.usage.blocked).toBe(true);
    });

    it('sets blocked to false when limit_reached is false', async () => {
      const apiResponse = {
        rate_limit: {
          primary_window: { used_percent: 50, reset_after_seconds: 1800, limit_window_seconds: 18000 },
          limit_reached: false,
        },
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(apiResponse), { status: 200 }));
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const credential = {
        token: JSON.stringify({ tokens: { account_id: 'acct-1', access_token: 'at-tok' } }),
        fingerprint: 'acct-1',
        metadata: {},
      };

      const result = await source.resolveUsage(credential);

      expect(result).not.toBeNull();
      expect(result!.usage.blocked).toBe(false);
    });

    it('maps credits when present', async () => {
      const apiResponse = {
        rate_limit: {
          primary_window: { used_percent: 20, reset_after_seconds: 3600, limit_window_seconds: 18000 },
          limit_reached: false,
        },
        credits: { has_credits: true, balance: '$10.00' },
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(apiResponse), { status: 200 }));
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const credential = {
        token: JSON.stringify({ tokens: { account_id: 'acct-1', access_token: 'at-tok' } }),
        fingerprint: 'acct-1',
        metadata: {},
      };

      const result = await source.resolveUsage(credential);

      expect(result).not.toBeNull();
      expect(result!.usage.credits).toMatchObject({ enabled: true, balance: '$10.00' });
    });

    it('omits credits when absent from response', async () => {
      const apiResponse = {
        rate_limit: {
          primary_window: { used_percent: 20, reset_after_seconds: 3600, limit_window_seconds: 18000 },
          limit_reached: false,
        },
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(apiResponse), { status: 200 }));
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const credential = {
        token: JSON.stringify({ tokens: { account_id: 'acct-1', access_token: 'at-tok' } }),
        fingerprint: 'acct-1',
        metadata: {},
      };

      const result = await source.resolveUsage(credential);

      expect(result).not.toBeNull();
      expect(result!.usage.credits).toBeUndefined();
    });

    it('computes resetsAt as an epoch ms offset from Date.now()', async () => {
      const beforeFetch = Date.now();
      const apiResponse = {
        rate_limit: {
          primary_window: { used_percent: 10, reset_after_seconds: 3600, limit_window_seconds: 18000 },
          limit_reached: false,
        },
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(apiResponse), { status: 200 }));
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const credential = {
        token: JSON.stringify({ tokens: { account_id: 'acct-1', access_token: 'at-tok' } }),
        fingerprint: 'acct-1',
        metadata: {},
      };

      const result = await source.resolveUsage(credential);
      const afterFetch = Date.now();

      expect(result).not.toBeNull();
      const expectedMin = beforeFetch + 3600 * 1000;
      const expectedMax = afterFetch + 3600 * 1000;
      expect(result!.usage.windows[0].resetsAt).toBeGreaterThanOrEqual(expectedMin);
      expect(result!.usage.windows[0].resetsAt).toBeLessThanOrEqual(expectedMax);
    });

    it('rejects finite usage windows that violate the canonical schema', () => {
      expect(
        parseUsageWindow(
          { used_percent: 101, reset_after_seconds: 3600, limit_window_seconds: 18000 },
          '5h',
          '5 Hour',
          'overall',
        ),
      ).toBeNull();
      expect(
        parseUsageWindow(
          { used_percent: 50, reset_after_seconds: 3600, limit_window_seconds: -1 },
          '5h',
          '5 Hour',
          'overall',
        ),
      ).toBeNull();
      expect(
        parseUsageWindow(
          { used_percent: 50, reset_after_seconds: 0.0001, limit_window_seconds: 18000 },
          '5h',
          '5 Hour',
          'overall',
        ),
      ).toBeNull();
    });

    it('extracts plan_type into metadataPatches when present', async () => {
      const apiResponse = {
        rate_limit: {
          primary_window: { used_percent: 20, reset_after_seconds: 3600, limit_window_seconds: 18000 },
          limit_reached: false,
        },
        plan_type: 'plus',
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(apiResponse), { status: 200 }));
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const credential = {
        token: JSON.stringify({ tokens: { account_id: 'acct-1', access_token: 'at-tok' } }),
        fingerprint: 'acct-1',
        metadata: {},
      };

      const result = await source.resolveUsage(credential);

      expect(result).not.toBeNull();
      expect(result!.metadataPatches).toEqual({ planType: 'plus' });
    });

    it('omits metadataPatches when plan_type is absent', async () => {
      const apiResponse = {
        rate_limit: {
          primary_window: { used_percent: 20, reset_after_seconds: 3600, limit_window_seconds: 18000 },
          limit_reached: false,
        },
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(apiResponse), { status: 200 }));
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const credential = {
        token: JSON.stringify({ tokens: { account_id: 'acct-1', access_token: 'at-tok' } }),
        fingerprint: 'acct-1',
        metadata: {},
      };

      const result = await source.resolveUsage(credential);

      expect(result).not.toBeNull();
      expect(result!.metadataPatches).toBeUndefined();
    });

    it('parses additional_rate_limits into model-specific windows', async () => {
      const apiResponse = {
        rate_limit: {
          primary_window: { used_percent: 10, reset_after_seconds: 3600, limit_window_seconds: 18000 },
          limit_reached: false,
        },
        additional_rate_limits: [
          {
            limit_name: 'gpt-5.3-codex-spark',
            metered_feature: 'model_usage',
            rate_limit: {
              primary_window: { used_percent: 50, reset_after_seconds: 1800, limit_window_seconds: 18000 },
              secondary_window: { used_percent: 25, reset_after_seconds: 86400, limit_window_seconds: 604800 },
            },
          },
        ],
      };
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify(apiResponse), { status: 200 }));
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const credential = {
        token: JSON.stringify({ tokens: { account_id: 'acct-1', access_token: 'at-tok' } }),
        fingerprint: 'acct-1',
        metadata: {},
      };

      const result = await source.resolveUsage(credential);

      expect(result).not.toBeNull();
      // 1 overall window + 2 model-specific windows
      expect(result!.usage.windows).toHaveLength(3);
      expect(result!.usage.windows[1]).toMatchObject({
        id: 'gpt-5.3-codex-spark-5h',
        label: 'gpt-5.3-codex-spark (5 Hour)',
        group: 'model',
        utilization: 50,
        windowSeconds: 18000,
      });
      expect(result!.usage.windows[2]).toMatchObject({
        id: 'gpt-5.3-codex-spark-7d',
        label: 'gpt-5.3-codex-spark (7 Day)',
        group: 'model',
        utilization: 25,
        windowSeconds: 604800,
      });
    });

    it('returns null when the fetch times out after 3 seconds', async () => {
      vi.useFakeTimers();
      try {
        mockFetchAbortOnSignal();
        const backend = new InMemoryBackend();
        const source = new CodexSource(backend);
        const credential = {
          token: JSON.stringify({ tokens: { account_id: 'acct-1', access_token: 'at-tok' } }),
          fingerprint: 'acct-1',
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

  describe('extractCredentialKey()', () => {
    it('returns account_id for a chatgpt-mode token', () => {
      const source = new CodexSource(new InMemoryBackend());
      const raw = JSON.stringify({ tokens: { account_id: 'acct-uuid-1234' } });

      expect(source.extractCredentialKey(raw)).toBe('acct-uuid-1234');
    });

    it('returns computeFingerprint(apiKey) for an apikey-mode token', () => {
      const source = new CodexSource(new InMemoryBackend());
      const apiKey = 'sk-test-api-key-12345';
      const raw = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: apiKey });

      expect(source.extractCredentialKey(raw)).toBe(computeFingerprint(apiKey));
    });

    it('returns null for unparseable token', () => {
      const source = new CodexSource(new InMemoryBackend());

      expect(source.extractCredentialKey('not-valid-json{{')).toBeNull();
    });

    it('returns null when account_id is missing in chatgpt mode', () => {
      const source = new CodexSource(new InMemoryBackend());
      const raw = JSON.stringify({ tokens: { access_token: 'some-token' } });

      expect(source.extractCredentialKey(raw)).toBeNull();
    });

    it('returns null when OPENAI_API_KEY is missing in apikey mode', () => {
      const source = new CodexSource(new InMemoryBackend());
      const raw = JSON.stringify({ auth_mode: 'apikey' });

      expect(source.extractCredentialKey(raw)).toBeNull();
    });

    it('returns null when OPENAI_API_KEY is empty in apikey mode', () => {
      const source = new CodexSource(new InMemoryBackend());
      const raw = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: '' });

      expect(source.extractCredentialKey(raw)).toBeNull();
    });
  });

  describe('resolveLabel()', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('prefers name/email claims from id_token without requiring a network fetch', async () => {
      const idToken = makeFakeJwt({
        name: 'Business User',
        email: 'business@example.com',
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const source = new CodexSource(new InMemoryBackend());

      const label = await source.resolveLabel({
        token: JSON.stringify({
          tokens: {
            account_id: 'acct-business',
            id_token: idToken,
          },
        }),
        fingerprint: 'acct-business',
        metadata: {},
      });

      expect(label).toBe('Business User (business@example.com)');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns label from id_token when no auth namespace contradicts account_id', async () => {
      const idToken = makeFakeJwt({
        sub: 'acct-match',
        name: 'Match User',
        email: 'match@example.com',
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const source = new CodexSource(new InMemoryBackend());

      const label = await source.resolveLabel({
        token: JSON.stringify({
          tokens: {
            account_id: 'acct-match',
            id_token: idToken,
          },
        }),
        fingerprint: 'acct-match',
        metadata: {},
      });

      expect(label).toBe('Match User (match@example.com)');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('falls through to /v1/me when id_token chatgpt_account_id differs from tokens.account_id', async () => {
      const idToken = makeFakeJwt({
        sub: 'acct-different-user',
        name: 'Wrong User',
        email: 'wrong@example.com',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct-different-org',
        },
      });
      // Mock fetch to return a 500 (no network available) — the point is that
      // labelFromIdToken returned null and the code fell through to fetchAccountInfo.
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
      const source = new CodexSource(new InMemoryBackend());

      const label = await source.resolveLabel({
        token: JSON.stringify({
          tokens: {
            account_id: 'acct-real-user',
            id_token: idToken,
            access_token: 'fake-access-token',
          },
        }),
        fingerprint: 'acct-real-user',
        metadata: {},
      });

      // Label should be null (id_token rejected, network failed).
      expect(label).toBeNull();
      // But fetch WAS called (fell through to /v1/me).
      expect(fetchSpy).toHaveBeenCalled();
    });

    it('returns label from id_token when account_id is absent', async () => {
      const idToken = makeFakeJwt({
        sub: 'some-user',
        name: 'No AccountId',
        email: 'noaccountid@example.com',
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const source = new CodexSource(new InMemoryBackend());

      const label = await source.resolveLabel({
        token: JSON.stringify({
          tokens: {
            id_token: idToken,
          },
        }),
        fingerprint: 'some-fp',
        metadata: {},
      });

      expect(label).toBe('No AccountId (noaccountid@example.com)');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('checks user_id from OpenAI auth namespace when sub is absent', async () => {
      const idToken = makeFakeJwt({
        name: 'Namespace User',
        email: 'ns@example.com',
        'https://api.openai.com/auth': {
          user_id: 'acct-ns-user',
          chatgpt_plan_type: 'plus',
        },
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      const source = new CodexSource(new InMemoryBackend());

      const label = await source.resolveLabel({
        token: JSON.stringify({
          tokens: {
            account_id: 'acct-ns-user',
            id_token: idToken,
          },
        }),
        fingerprint: 'acct-ns-user',
        metadata: {},
      });

      expect(label).toBe('Namespace User (ns@example.com)');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('refreshIfNeeded()', () => {
    /**
     * Builds a ChatGPT-mode RawCredential for refresh testing.
     *
     * The access_token is a fake (unsigned) JWT with a configurable `exp` claim.
     * @param overrides - Fields to merge into the CodexAuth token object.
     */
    function createChatgptCredential(
      overrides: {
        auth_mode?: string;
        accessTokenExp?: number;
        omitAccessToken?: boolean;
        omitTokens?: boolean;
        omitIdToken?: boolean;
        omitExpClaim?: boolean;
        idTokenPayload?: Record<string, unknown>;
        refreshToken?: string;
        accountId?: string;
        lastRefresh?: string;
      } = {},
    ) {
      const accountId = overrides.accountId ?? 'test-account-id-1234';
      const exp = overrides.accessTokenExp ?? Math.floor((Date.now() - 60_000) / 1000);
      const accessTokenPayload = overrides.omitExpClaim ? { sub: 'user-1' } : { sub: 'user-1', exp };
      const accessToken = makeFakeJwt(accessTokenPayload);
      const idToken = makeFakeJwt(
        overrides.idTokenPayload ?? {
          sub: accountId,
          'https://api.openai.com/auth': { chatgpt_plan_type: 'free' },
        },
      );

      const tokens: Record<string, unknown> = {
        account_id: accountId,
        refresh_token: overrides.refreshToken ?? 'dummy-refresh-token',
      };

      if (!overrides.omitIdToken) {
        tokens['id_token'] = idToken;
      }

      if (!overrides.omitAccessToken) {
        tokens['access_token'] = accessToken;
      }

      const auth: Record<string, unknown> = {
        auth_mode: overrides.auth_mode ?? 'chatgpt',
        last_refresh: overrides.lastRefresh ?? new Date(Date.now() - 3_600_000).toISOString(),
      };

      if (!overrides.omitTokens) {
        auth['tokens'] = tokens;
      }

      const raw = JSON.stringify(auth);
      return {
        token: raw,
        fingerprint: accountId,
        metadata: { authMode: 'chatgpt', accountId },
      };
    }

    /**
     * Builds a successful token-exchange HTTP response.
     * @param opts - Response field overrides.
     */
    function tokenExchangeResponse(
      opts: { access_token?: string; id_token?: string; refresh_token?: string; expires_in?: number } = {},
    ): Response {
      return new Response(
        JSON.stringify({
          access_token: opts.access_token ?? 'new-access-token-jwt',
          id_token:
            opts.id_token ??
            makeFakeJwt({ sub: 'user-1', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' } }),
          refresh_token: opts.refresh_token ?? 'new-refresh-token',
          expires_in: opts.expires_in ?? 864000,
        }),
        { status: 200 },
      );
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns unchanged when auth_mode is apikey', async () => {
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const credential = {
        token: JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test-key' }),
        fingerprint: computeFingerprint('sk-test-key'),
        metadata: { authMode: 'apikey', apiProvider: 'openai' },
      };

      await expect(source.refreshIfNeeded(credential)).resolves.toEqual({ status: 'unchanged' });
    });

    it('enters the refresh path for a credential with no auth_mode field (implicit chatgpt mode)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        tokenExchangeResponse({ access_token: 'implicit-chatgpt-new-access-token' }),
      );
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      // Expired token, no auth_mode field — should be treated as chatgpt mode
      const exp = Math.floor((Date.now() - 60_000) / 1000);
      const credential = createChatgptCredential({ accessTokenExp: exp });
      // Strip the auth_mode field to simulate the implicit chatgpt case
      const parsed = JSON.parse(credential.token) as Record<string, unknown>;
      delete parsed['auth_mode'];
      const credentialWithoutAuthMode = { ...credential, token: JSON.stringify(parsed) };

      const result = await source.refreshIfNeeded(credentialWithoutAuthMode);

      expect(result.status).toBe('refreshed');
    });

    it('returns unchanged when tokens are missing', async () => {
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const credential = createChatgptCredential({ omitTokens: true });

      await expect(source.refreshIfNeeded(credential)).resolves.toEqual({ status: 'unchanged' });
    });

    it('returns unchanged when access_token is missing', async () => {
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const credential = createChatgptCredential({ omitAccessToken: true });

      await expect(source.refreshIfNeeded(credential)).resolves.toEqual({ status: 'unchanged' });
    });

    it('returns unchanged when token is not expired (beyond 5-minute buffer)', async () => {
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      // 10 minutes in the future — well outside the 5-minute buffer
      const exp = Math.floor((Date.now() + 10 * 60 * 1000) / 1000);
      const credential = createChatgptCredential({ accessTokenExp: exp });

      await expect(source.refreshIfNeeded(credential)).resolves.toEqual({ status: 'unchanged' });
    });

    it('bypasses expiry guard and refreshes when force is true', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        tokenExchangeResponse({ access_token: 'forced-new-access-token' }),
      );
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      // 10 minutes from now — well outside the 5-minute buffer, normally unchanged
      const exp = Math.floor((Date.now() + 10 * 60 * 1000) / 1000);
      const credential = createChatgptCredential({ accessTokenExp: exp });

      const result = await source.refreshIfNeeded(credential, { force: true });

      expect(result.status).toBe('refreshed');
      if (result.status !== 'refreshed') throw new Error(`Expected refreshed, got ${result.status}`);
      const parsed = JSON.parse(result.credential.token) as Record<string, unknown>;
      const tokens = parsed['tokens'] as Record<string, unknown>;
      expect(tokens['access_token']).toBe('forced-new-access-token');
    });

    it('returns unchanged when exp claim is missing from access_token JWT', async () => {
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const credential = createChatgptCredential({ omitExpClaim: true });

      await expect(source.refreshIfNeeded(credential)).resolves.toEqual({ status: 'unchanged' });
    });

    it('triggers refresh when token expires within the 5-minute buffer', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        tokenExchangeResponse({ access_token: 'buffered-new-access-token' }),
      );
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      // 3 minutes in the future — inside the 5-minute proactive buffer
      const exp = Math.floor((Date.now() + 3 * 60 * 1000) / 1000);
      const credential = createChatgptCredential({ accessTokenExp: exp });

      const result = await source.refreshIfNeeded(credential);

      expect(result.status).toBe('refreshed');
      if (result.status !== 'refreshed') {
        throw new Error(`Expected refreshed result, received ${result.status}`);
      }
      const parsed = JSON.parse(result.credential.token) as Record<string, unknown>;
      const tokens = parsed['tokens'] as Record<string, unknown>;
      expect(tokens['access_token']).toBe('buffered-new-access-token');
    });

    it('refreshes an expired token and returns updated credential', async () => {
      const newIdToken = makeFakeJwt({
        sub: 'test-account-id-1234',
        'https://api.openai.com/auth': { chatgpt_plan_type: 'plus' },
      });
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        tokenExchangeResponse({
          access_token: 'refreshed-access-token',
          id_token: newIdToken,
          refresh_token: 'refreshed-refresh-token',
        }),
      );
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      // Expired: 60 seconds in the past
      const exp = Math.floor((Date.now() - 60_000) / 1000);
      const credential = createChatgptCredential({ accessTokenExp: exp, accountId: 'test-account-id-1234' });

      const result = await source.refreshIfNeeded(credential);

      expect(result.status).toBe('refreshed');
      if (result.status !== 'refreshed') {
        throw new Error(`Expected refreshed result, received ${result.status}`);
      }

      // access_token updated in the rebuilt credential
      const parsed = JSON.parse(result.credential.token) as Record<string, unknown>;
      const tokens = parsed['tokens'] as Record<string, unknown>;
      expect(tokens['access_token']).toBe('refreshed-access-token');

      // last_refresh updated to a recent ISO timestamp
      expect(typeof parsed['last_refresh']).toBe('string');

      // fingerprint is account_id-based and unchanged across refreshes
      expect(result.credential.fingerprint).toBe('test-account-id-1234');

      // metadata re-derived from the updated id_token
      expect(result.credential.metadata).toMatchObject({ authMode: 'chatgpt', planType: 'plus' });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('updates id_token and refresh_token when returned by the endpoint', async () => {
      const updatedIdToken = makeFakeJwt({
        sub: 'test-account-id-1234',
        name: 'Token User',
        email: 'token@example.com',
        'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' },
      });
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        tokenExchangeResponse({
          access_token: 'new-at',
          id_token: updatedIdToken,
          refresh_token: 'new-rt',
        }),
      );
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const exp = Math.floor((Date.now() - 60_000) / 1000);
      const credential = createChatgptCredential({ accessTokenExp: exp });

      const result = await source.refreshIfNeeded(credential);

      expect(result.status).toBe('refreshed');
      if (result.status !== 'refreshed') {
        throw new Error(`Expected refreshed result, received ${result.status}`);
      }
      const parsed = JSON.parse(result.credential.token) as Record<string, unknown>;
      const tokens = parsed['tokens'] as Record<string, unknown>;
      expect(tokens['id_token']).toBe(updatedIdToken);
      expect(tokens['refresh_token']).toBe('new-rt');
    });

    it('falls back to refresh_token when id_token is missing', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(tokenExchangeResponse());
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const exp = Math.floor((Date.now() - 60_000) / 1000);
      const credential = createChatgptCredential({ accessTokenExp: exp, omitIdToken: true });

      const result = await source.refreshIfNeeded(credential);

      expect(result.status).toBe('refreshed');
      const params = new URLSearchParams(String(fetchSpy.mock.calls[0]?.[1]?.body));
      expect(params.get('grant_type')).toBe('refresh_token');
    });

    it('falls back to refresh_token when id_token is expired', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(tokenExchangeResponse());
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const exp = Math.floor((Date.now() - 60_000) / 1000);
      const idTokenExp = Math.floor((Date.now() - 3_600_000) / 1000);
      const credential = createChatgptCredential({
        accessTokenExp: exp,
        idTokenPayload: { sub: 'user-1', exp: idTokenExp },
      });

      const result = await source.refreshIfNeeded(credential);

      expect(result.status).toBe('refreshed');
      const params = new URLSearchParams(String(fetchSpy.mock.calls[0]?.[1]?.body));
      expect(params.get('grant_type')).toBe('refresh_token');
      expect(params.get('refresh_token')).toBe('dummy-refresh-token');
    });

    it('prefers id_token token exchange when id_token is still valid', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(tokenExchangeResponse());
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const exp = Math.floor((Date.now() - 60_000) / 1000);
      const idTokenExp = Math.floor((Date.now() + 60 * 60 * 1000) / 1000);
      const credential = createChatgptCredential({
        accessTokenExp: exp,
        idTokenPayload: { sub: 'user-1', exp: idTokenExp },
      });

      const result = await source.refreshIfNeeded(credential);

      expect(result.status).toBe('refreshed');
      const params = new URLSearchParams(String(fetchSpy.mock.calls[0]?.[1]?.body));
      expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    });

    it('returns failed when id_token expired and no refresh_token available', async () => {
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const exp = Math.floor((Date.now() - 60_000) / 1000);
      const idTokenExp = Math.floor((Date.now() - 3_600_000) / 1000);
      const credential = createChatgptCredential({
        accessTokenExp: exp,
        idTokenPayload: { sub: 'user-1', exp: idTokenExp },
        refreshToken: '',
      });

      await expect(source.refreshIfNeeded(credential)).resolves.toMatchObject({
        status: 'failed',
        reason: expect.stringContaining('refresh_token'),
      });
    });

    it('returns failed when refresh_token endpoint rejects with 4xx', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 401 }));
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const exp = Math.floor((Date.now() - 60_000) / 1000);
      const credential = createChatgptCredential({ accessTokenExp: exp, omitIdToken: true });

      await expect(source.refreshIfNeeded(credential)).resolves.toMatchObject({
        status: 'failed',
        reason: expect.stringContaining('HTTP 401'),
      });
    });

    it.each([
      400, 403, 401,
    ])('returns failed when the refresh endpoint returns HTTP %i (client error)', async (status) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status }));
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const exp = Math.floor((Date.now() - 60_000) / 1000);
      const credential = createChatgptCredential({ accessTokenExp: exp });

      await expect(source.refreshIfNeeded(credential)).resolves.toMatchObject({
        status: 'failed',
        reason: expect.stringContaining(`HTTP ${status}`),
      });
    });

    it.each([
      500, 502, 503,
    ])('returns transient when the refresh endpoint returns HTTP %i (server error)', async (status) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status }));
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const exp = Math.floor((Date.now() - 60_000) / 1000);
      const credential = createChatgptCredential({ accessTokenExp: exp });

      await expect(source.refreshIfNeeded(credential)).resolves.toMatchObject({
        status: 'transient',
        reason: expect.stringContaining(`HTTP ${status}`),
      });
    });

    it('returns transient when the refresh endpoint returns HTTP 429 (rate-limited)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 429 }));
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const exp = Math.floor((Date.now() - 60_000) / 1000);
      const credential = createChatgptCredential({ accessTokenExp: exp });

      await expect(source.refreshIfNeeded(credential)).resolves.toMatchObject({
        status: 'transient',
        reason: expect.stringContaining('HTTP 429'),
      });
    });

    it('returns transient when the refresh endpoint times out after 5 seconds', async () => {
      vi.useFakeTimers();
      try {
        mockFetchAbortOnSignal();
        const backend = new InMemoryBackend();
        const source = new CodexSource(backend);
        const exp = Math.floor((Date.now() - 60_000) / 1000);
        const credential = createChatgptCredential({ accessTokenExp: exp });

        let settled = false;
        const promise = source.refreshIfNeeded(credential).finally(() => {
          settled = true;
        });

        await vi.advanceTimersByTimeAsync(4999);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await expect(promise).resolves.toMatchObject({
          status: 'transient',
          reason: expect.stringMatching(/abort/i),
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('sends correct token exchange parameters to the endpoint', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(tokenExchangeResponse());
      const backend = new InMemoryBackend();
      const source = new CodexSource(backend);
      const exp = Math.floor((Date.now() - 60_000) / 1000);
      const idTokenExp = Math.floor((Date.now() + 60 * 60 * 1000) / 1000);
      const credential = createChatgptCredential({
        accessTokenExp: exp,
        idTokenPayload: { sub: 'user-1', exp: idTokenExp },
      });
      // Extract the id_token the helper embedded so we can assert it was sent
      const parsedToken = JSON.parse(credential.token) as {
        tokens: { id_token: string };
      };
      const embeddedIdToken = parsedToken.tokens.id_token;

      await source.refreshIfNeeded(credential);

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0] ?? [];
      expect(url).toBe('https://auth.openai.com/oauth/token');
      expect(init?.method).toBe('POST');
      const params = new URLSearchParams(String(init?.body));
      expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
      expect(params.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
      expect(params.get('subject_token')).toBe(embeddedIdToken);
      expect(params.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:id_token');
    });
  });

  describe('installation and config probing', () => {
    it('detects installation via the injected codex home', async () => {
      const root = await mkdtemp(join(tmpdir(), 'codex-source-'));
      const codexHome = join(root, '.codex');
      const authPath = join(codexHome, 'auth.json');

      try {
        const source = new CodexSource(new FileBackend(authPath), { codexHome });
        await expect(source.isAvailable()).resolves.toBe(false);

        await mkdir(codexHome, { recursive: true });
        await expect(source.isAvailable()).resolves.toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('reports a config issue until file mode is enabled', async () => {
      const root = await mkdtemp(join(tmpdir(), 'codex-source-'));
      const codexHome = join(root, '.codex');
      const authPath = join(codexHome, 'auth.json');

      try {
        await mkdir(codexHome, { recursive: true });
        const source = new CodexSource(new FileBackend(authPath), { codexHome });

        await expect(source.getConfigIssue()).resolves.toMatchObject({
          reason: 'Credentials stored in OS keychain',
        });

        await writeFile(join(codexHome, 'config.toml'), 'cli_auth_credentials_store = "file"\n', 'utf-8');

        await expect(source.getConfigIssue()).resolves.toBeNull();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
