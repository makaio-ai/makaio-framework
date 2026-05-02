import { describe, it, expect, vi, afterEach } from 'vitest';
import { ClaudeCodeSource } from '../sources/claude-code-source.js';
import { computeFingerprint } from '../utils/fingerprint.js';
import { InMemoryBackend } from './testing/in-memory-backend.js';

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

  describe('extractCredentialKey()', () => {
    it('returns the refresh-token hash for flat credentials', () => {
      const source = new ClaudeCodeSource(new InMemoryBackend());

      expect(source.extractCredentialKey(JSON.stringify({ refreshToken: 'rt-flat' }))).toBe(
        computeFingerprint('rt-flat'),
      );
    });

    it('returns the refresh-token hash for claudeAiOauth credentials', () => {
      const source = new ClaudeCodeSource(new InMemoryBackend());

      expect(source.extractCredentialKey(JSON.stringify({ claudeAiOauth: { refreshToken: 'rt-envelope' } }))).toBe(
        computeFingerprint('rt-envelope'),
      );
    });

    it('returns null when the credential payload has no refresh token', () => {
      const source = new ClaudeCodeSource(new InMemoryBackend());

      expect(source.extractCredentialKey(JSON.stringify({ accessToken: 'only-at' }))).toBeNull();
    });
  });
});
