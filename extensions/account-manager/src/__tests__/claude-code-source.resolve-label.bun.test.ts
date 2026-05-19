import { describe, it, expect, afterEach, mock, spyOn } from 'bun:test';
import { ClaudeCodeSource } from '../sources/claude-code-source.js';
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
    mock.restore();
  });

  describe('resolveLabel()', () => {
    it('returns null when credential has no accessToken', async () => {
      const source = new ClaudeCodeSource(new InMemoryBackend());

      await expect(
        source.resolveLabel({
          token: JSON.stringify({ refreshToken: 'rt' }),
          fingerprint: 'fp',
          metadata: {},
        }),
      ).resolves.toBeNull();
    });

    it('returns null when credential is not valid JSON', async () => {
      const source = new ClaudeCodeSource(new InMemoryBackend());

      await expect(
        source.resolveLabel({
          token: 'not-json',
          fingerprint: 'fp',
          metadata: {},
        }),
      ).resolves.toBeNull();
    });

    it('returns a combined org/email label from the profile endpoint', async () => {
      spyOn(globalThis, 'fetch').mockResolvedValueOnce(profileResponse({ orgName: 'Acme', email: 'user@example.com' }));
      const source = new ClaudeCodeSource(new InMemoryBackend());

      await expect(
        source.resolveLabel({
          token: JSON.stringify({ refreshToken: 'rt', accessToken: 'at' }),
          fingerprint: 'fp',
          metadata: {},
        }),
      ).resolves.toBe('Acme (user@example.com)');
    });

    it('returns email-only label when org name is missing', async () => {
      spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            account: { uuid: 'acct-1', email: 'solo@example.com' },
            organization: { uuid: 'org-1' },
          }),
          { status: 200 },
        ),
      );
      const source = new ClaudeCodeSource(new InMemoryBackend());

      await expect(
        source.resolveLabel({
          token: JSON.stringify({ refreshToken: 'rt', accessToken: 'at' }),
          fingerprint: 'fp',
          metadata: {},
        }),
      ).resolves.toBe('solo@example.com');
    });

    it('returns org-only label when email is missing', async () => {
      spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            account: { uuid: 'acct-1' },
            organization: { uuid: 'org-1', name: 'OrgOnly' },
          }),
          { status: 200 },
        ),
      );
      const source = new ClaudeCodeSource(new InMemoryBackend());

      await expect(
        source.resolveLabel({
          token: JSON.stringify({ refreshToken: 'rt', accessToken: 'at' }),
          fingerprint: 'fp',
          metadata: {},
        }),
      ).resolves.toBe('OrgOnly');
    });

    it('returns null when the profile fetch fails', async () => {
      spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network error'));
      const source = new ClaudeCodeSource(new InMemoryBackend());

      await expect(
        source.resolveLabel({
          token: JSON.stringify({ refreshToken: 'rt', accessToken: 'at' }),
          fingerprint: 'fp',
          metadata: {},
        }),
      ).resolves.toBeNull();
    });

    it('unwraps claudeAiOauth envelope to extract tokens', async () => {
      const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        profileResponse({ orgName: 'EnvOrg', email: 'env@example.com' }),
      );
      const source = new ClaudeCodeSource(new InMemoryBackend());

      await expect(
        source.resolveLabel({
          token: JSON.stringify({ claudeAiOauth: { refreshToken: 'rt', accessToken: 'at-env' } }),
          fingerprint: 'fp',
          metadata: {},
        }),
      ).resolves.toBe('EnvOrg (env@example.com)');

      expect(fetchSpy).toHaveBeenCalledWith(
        'https://api.anthropic.com/api/oauth/profile',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer at-env' }),
        }),
      );
    });

    it('uses cached profile from a prior read() call', async () => {
      const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
        profileResponse({ orgName: 'CachedOrg', email: 'cached@example.com' }),
      );
      const backend = new InMemoryBackend();
      backend.set(JSON.stringify({ refreshToken: 'rt-shared', accessToken: 'at-shared' }));
      const source = new ClaudeCodeSource(backend);

      // read() populates the profile cache
      await source.read();

      // resolveLabel() should reuse the cached profile
      const label = await source.resolveLabel({
        token: JSON.stringify({ refreshToken: 'rt-shared', accessToken: 'at-shared' }),
        fingerprint: 'fp',
        metadata: {},
      });

      expect(label).toBe('CachedOrg (cached@example.com)');
      // Only one fetch — the profile call from read(); resolveLabel() used cache
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
  });
});
