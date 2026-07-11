import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { FileBackend } from '../backends/file-backend.js';
import { ClaudeCodeSource } from '../sources/claude-code-source.js';
import { computeFingerprint } from '../utils/fingerprint.js';

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

  describe('integration with FileBackend', () => {
    it('returns null for credential without accessToken', async () => {
      const root = await mkdtemp(join(tmpdir(), 'claude-source-'));
      const claudeHome = join(root, '.claude');
      const credentialPath = join(claudeHome, '.credentials.json');
      const raw = JSON.stringify({
        refreshToken: 'real-backend-refresh-token',
        subscriptionType: 'pro',
      });

      try {
        await mkdir(claudeHome, { recursive: true });
        const canonicalClaudeHome = await realpath(claudeHome);

        const source = new ClaudeCodeSource(new FileBackend(credentialPath), {
          installDir: canonicalClaudeHome,
        });

        await source.write({
          token: raw,
          fingerprint: computeFingerprint('real-backend-refresh-token'),
          metadata: {},
        });

        // No accessToken → read() returns null (no hash-based fallback)
        await expect(source.read()).resolves.toBeNull();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
