import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import { acquireClaudeConformanceSessionConfigFixture } from './session-config-fixture.js';

const FIXTURE_ROOT_PREFIX = 'makaio-claude-conformance-config-';

/** List every Claude conformance fixture root visible to this worker. */
async function listFixtureRoots(): Promise<string[]> {
  const entries = await fs.readdir(os.tmpdir(), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(FIXTURE_ROOT_PREFIX))
    .map((entry) => path.join(os.tmpdir(), entry.name));
}

afterEach(() => {
  MakaioBus.__resetHandlers?.();
});

describe('Claude conformance session-config fixture lifecycle', () => {
  it('removes a newly created lease directory when real client setup fails', async () => {
    const invalidBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-claude-invalid-config-'));
    await fs.writeFile(path.join(invalidBaseDir, 'settings.json'), '{', 'utf8');
    const fixture = await acquireClaudeConformanceSessionConfigFixture();
    const leaseId = `failed-setup-${crypto.randomUUID()}`;

    try {
      await expect(
        MakaioBus.request(ClientSubjects.sessionConfig.create, {
          clientId: 'claude-code',
          leaseId,
          baseConfigDir: invalidBaseDir,
          projectDir: invalidBaseDir,
          configInheritance: 'full',
        }),
      ).rejects.toThrow();

      for (const root of await listFixtureRoots()) {
        const sessionDir = path.join(root, 'claude-code', 'sessions', leaseId);
        await expect(fs.stat(sessionDir)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    } finally {
      await fixture.release();
      await fs.rm(invalidBaseDir, { recursive: true, force: true });
    }
  });
});
