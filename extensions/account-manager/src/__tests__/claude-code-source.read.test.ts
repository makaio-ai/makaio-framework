import { describe, it, expect, vi, afterEach } from 'vitest';
import { ClaudeCodeSource } from '../sources/claude-code-source.js';
import { computeFingerprint } from '../utils/fingerprint.js';
import { InMemoryBackend } from './testing/in-memory-backend.js';

/**
 * Builds a mock profile API response for the given account/org UUIDs.
 * @param opts - Profile field overrides.
 */
function profileResponse(opts: { accountUuid?: string; orgUuid?: string; orgName?: string; email?: string }): Response {
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

  describe('read()', () => {
    it('returns null when backend is empty', async () => {
      const backend = new InMemoryBackend();
      const source = new ClaudeCodeSource(backend);

      const result = await source.read();

      expect(result).toBeNull();
    });

    it('returns null for invalid JSON', async () => {
      const backend = new InMemoryBackend();
      backend.set('not-valid-json{{');
      const source = new ClaudeCodeSource(backend);

      const result = await source.read();

      expect(result).toBeNull();
    });

    it('returns null when refreshToken is missing', async () => {
      const backend = new InMemoryBackend();
      backend.set(JSON.stringify({ someOtherField: 'value' }));
      const source = new ClaudeCodeSource(backend);

      const result = await source.read();

      expect(result).toBeNull();
    });

    it('returns null when no accessToken is present', async () => {
      const backend = new InMemoryBackend();
      const raw = JSON.stringify({ refreshToken: 'test-refresh-token' });
      backend.set(raw);
      const source = new ClaudeCodeSource(backend);

      const result = await source.read();

      expect(result).toBeNull();
    });

    it('uses stable profile-based fingerprint when accessToken is present', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        profileResponse({ accountUuid: 'acct-aaa', orgUuid: 'org-bbb' }),
      );
      const backend = new InMemoryBackend();
      backend.set(JSON.stringify({ refreshToken: 'rt-1', accessToken: 'at-1' }));
      const source = new ClaudeCodeSource(backend);

      const result = await source.read();

      expect(result).not.toBeNull();
      expect(result!.fingerprint).toBe('acct-aaa:org-bbb');
    });

    it('throws on transient network failure so poll() emits credentials.error', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network error'));
      const backend = new InMemoryBackend();
      backend.set(JSON.stringify({ refreshToken: 'rt-offline', accessToken: 'at-offline' }));
      const source = new ClaudeCodeSource(backend);

      await expect(source.read()).rejects.toThrow('network error');
    });

    it('returns same stable fingerprint after refreshToken rotation', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      fetchSpy.mockResolvedValueOnce(profileResponse({ accountUuid: 'acct-1', orgUuid: 'org-1' }));
      fetchSpy.mockResolvedValueOnce(profileResponse({ accountUuid: 'acct-1', orgUuid: 'org-1' }));

      const backend = new InMemoryBackend();
      const source = new ClaudeCodeSource(backend);

      // First read with refreshToken A
      backend.set(JSON.stringify({ refreshToken: 'rt-a', accessToken: 'at-a' }));
      const first = await source.read();

      // Second read with refreshToken B (rotated)
      backend.set(JSON.stringify({ refreshToken: 'rt-b', accessToken: 'at-b' }));
      const second = await source.read();

      expect(first!.fingerprint).toBe('acct-1:org-1');
      expect(second!.fingerprint).toBe('acct-1:org-1');
      // Different refreshTokens would have produced different hash fingerprints
      expect(computeFingerprint('rt-a')).not.toBe(computeFingerprint('rt-b'));
    });

    it('throws after rotation when profile fetch fails transiently', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch');
      // First read: profile fetch succeeds.
      fetchSpy.mockResolvedValueOnce(profileResponse({ accountUuid: 'acct-stable', orgUuid: 'org-stable' }));
      // Second read after rotation: profile fetch fails transiently.
      fetchSpy.mockRejectedValueOnce(new Error('network error'));

      const backend = new InMemoryBackend();
      const source = new ClaudeCodeSource(backend);

      backend.set(JSON.stringify({ refreshToken: 'rt-before', accessToken: 'at-before' }));
      const first = await source.read();

      backend.set(JSON.stringify({ refreshToken: 'rt-after', accessToken: 'at-after' }));

      expect(first!.fingerprint).toBe('acct-stable:org-stable');
      await expect(source.read()).rejects.toThrow('network error');
    });

    it('caches profile response for the same refreshToken', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(profileResponse({ accountUuid: 'acct-cached', orgUuid: 'org-cached' }));

      const backend = new InMemoryBackend();
      backend.set(JSON.stringify({ refreshToken: 'rt-same', accessToken: 'at-same' }));
      const source = new ClaudeCodeSource(backend);

      await source.read();
      await source.read();

      // Profile should only be fetched once — second read uses the cache
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('extracts known metadata fields', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        profileResponse({ accountUuid: 'test-account-uuid', orgUuid: 'test-org-uuid' }),
      );
      const backend = new InMemoryBackend();
      backend.set(
        JSON.stringify({
          refreshToken: 'test-refresh-token',
          accessToken: 'test-access-token',
          subscriptionType: 'pro',
          rateLimitTier: 'high',
          scopes: 'read write',
        }),
      );
      const source = new ClaudeCodeSource(backend);

      const result = await source.read();

      expect(result).not.toBeNull();
      expect(result!.metadata).toMatchObject({
        accountUuid: 'test-account-uuid',
        orgUuid: 'test-org-uuid',
        planType: 'pro',
        subscriptionType: 'pro',
        rateLimitTier: 'high',
        scopes: 'read write',
      });
    });

    it('ignores unknown metadata fields', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        profileResponse({ accountUuid: 'test-account-uuid', orgUuid: 'test-org-uuid' }),
      );
      const backend = new InMemoryBackend();
      backend.set(
        JSON.stringify({
          refreshToken: 'test-refresh-token',
          accessToken: 'test-access-token',
          subscriptionType: 'pro',
          someUnknownField: 'should-not-appear',
          anotherUnknown: 42,
        }),
      );
      const source = new ClaudeCodeSource(backend);

      const result = await source.read();

      expect(result).not.toBeNull();
      expect(result!.metadata).not.toHaveProperty('someUnknownField');
      expect(result!.metadata).not.toHaveProperty('anotherUnknown');
    });

    describe('claudeAiOauth envelope (macOS keychain format)', () => {
      it('unwraps the claudeAiOauth envelope and parses the credential', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
          profileResponse({ accountUuid: 'test-account-uuid', orgUuid: 'test-org-uuid' }),
        );
        const backend = new InMemoryBackend();
        const raw = JSON.stringify({
          claudeAiOauth: { refreshToken: 'sk-ant-ort01-nested', accessToken: 'test-access-token' },
        });
        backend.set(raw);
        const source = new ClaudeCodeSource(backend);

        const result = await source.read();

        expect(result).not.toBeNull();
        // token is the full raw string — the envelope is preserved as-is
        expect(result!.token).toBe(raw);
        // UUID-based fingerprint from profile
        expect(result!.fingerprint).toBe('test-account-uuid:test-org-uuid');
      });

      it('uses stable fingerprint from profile when envelope has accessToken', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
          profileResponse({ accountUuid: 'acct-env', orgUuid: 'org-env' }),
        );
        const backend = new InMemoryBackend();
        backend.set(
          JSON.stringify({
            claudeAiOauth: { refreshToken: 'sk-ant-ort01-nested', accessToken: 'sk-ant-oat01-nested' },
          }),
        );
        const source = new ClaudeCodeSource(backend);

        const result = await source.read();

        expect(result).not.toBeNull();
        expect(result!.fingerprint).toBe('acct-env:org-env');
      });

      it('extracts metadata from inside the claudeAiOauth envelope', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
          profileResponse({ accountUuid: 'test-account-uuid', orgUuid: 'test-org-uuid' }),
        );
        const backend = new InMemoryBackend();
        backend.set(
          JSON.stringify({
            claudeAiOauth: {
              refreshToken: 'sk-ant-ort01-nested',
              accessToken: 'test-access-token',
              subscriptionType: 'max',
              rateLimitTier: 'default_claude_max_20x',
            },
          }),
        );
        const source = new ClaudeCodeSource(backend);

        const result = await source.read();

        expect(result).not.toBeNull();
        expect(result!.metadata).toMatchObject({
          planType: 'max',
          rateLimitTier: 'default_claude_max_20x',
        });
      });

      it('returns null when claudeAiOauth envelope is present but refreshToken is missing', async () => {
        const backend = new InMemoryBackend();
        backend.set(JSON.stringify({ claudeAiOauth: { accessToken: 'sk-ant-oat01-only' } }));
        const source = new ClaudeCodeSource(backend);

        const result = await source.read();

        expect(result).toBeNull();
      });

      it('returns null when claudeAiOauth value is not an object', async () => {
        const backend = new InMemoryBackend();
        backend.set(JSON.stringify({ claudeAiOauth: 'not-an-object' }));
        const source = new ClaudeCodeSource(backend);

        const result = await source.read();

        expect(result).toBeNull();
      });
    });
  });
});
