/// <reference types="bun-types" />
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, mock } from 'bun:test';
import { FileBackend } from '../backends/file-backend.js';
import { ClaudeCodeSource } from '../sources/claude-code-source.js';
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
    mock.restore();
  });

  describe('isAvailable()', () => {
    it('returns false when the install directory is missing', async () => {
      const root = await mkdtemp(join(tmpdir(), 'claude-source-'));
      try {
        const source = new ClaudeCodeSource(new InMemoryBackend(), {
          installDir: join(root, '.claude'),
        });
        await expect(source.isAvailable()).resolves.toBe(false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });

    it('returns true when the install directory exists and a real backend has credentials', async () => {
      const root = await mkdtemp(join(tmpdir(), 'claude-source-'));
      const claudeHome = join(root, '.claude');
      const credentialPath = join(claudeHome, '.credentials.json');
      const raw = JSON.stringify({ refreshToken: 'file-backed-token' });

      try {
        await mkdir(claudeHome, { recursive: true });
        await writeFile(credentialPath, raw, 'utf-8');

        const source = new ClaudeCodeSource(new FileBackend(credentialPath), {
          installDir: claudeHome,
        });

        await expect(source.isAvailable()).resolves.toBe(true);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  });
});
