import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/contracts/client';
import { acquireClaudeConformanceSessionConfigFixture } from './session-config-fixture.js';

afterEach(() => {
  vi.restoreAllMocks();
  MakaioBus.__resetHandlers?.();
});

describe('Claude conformance session-config fixture lifecycle', () => {
  it('removes a newly created lease directory when real client setup fails', async () => {
    const invalidBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-claude-invalid-config-'));
    await fs.writeFile(path.join(invalidBaseDir, 'settings.json'), '{', 'utf8');
    const fixture = await acquireClaudeConformanceSessionConfigFixture();
    const leaseId = `failed-setup-${crypto.randomUUID()}`;
    const originalRemove = fs.rm.bind(fs);
    const removedLeaseDirectories: string[] = [];
    vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      const resolvedTarget = target.toString();
      if (path.basename(resolvedTarget) === leaseId) {
        removedLeaseDirectories.push(resolvedTarget);
      }
      return originalRemove(target, options);
    });

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

      expect(removedLeaseDirectories).toHaveLength(1);
      const removedLeaseDirectory = removedLeaseDirectories[0];
      if (removedLeaseDirectory === undefined) throw new Error('Lease directory removal was not observed.');
      await expect(fs.stat(removedLeaseDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fixture.release();
      await fs.rm(invalidBaseDir, { recursive: true, force: true });
    }
  });
});
