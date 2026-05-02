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

  describe('write()', () => {
    it('delegates the token to the backend', async () => {
      const backend = new InMemoryBackend();
      const source = new ClaudeCodeSource(backend);
      const credential = {
        token: JSON.stringify({ refreshToken: 'my-token' }),
        fingerprint: computeFingerprint('my-token'),
        metadata: {},
      };

      await source.write(credential);

      expect(await backend.read()).toBe(credential.token);
    });
  });
});
