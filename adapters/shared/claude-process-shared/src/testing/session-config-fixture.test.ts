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

  it('keeps transcripts in the suite-scoped store across lease destruction', async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-claude-base-'));
    const fixture = await acquireClaudeConformanceSessionConfigFixture();
    const leaseId = `transcript-${crypto.randomUUID()}`;

    try {
      const created = await MakaioBus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'claude-code',
        leaseId,
        baseConfigDir: baseDir,
        configInheritance: 'auth-only',
      });

      // The lease's transcript store must resolve into the fixture root, never
      // into the operator's real config home.
      const storeDir = await fs.readlink(path.join(created.sessionDir, 'projects'));
      expect(path.basename(storeDir)).toBe('projects-store');
      expect(storeDir).not.toBe(path.join(os.homedir(), '.claude', 'projects'));

      const transcriptDir = path.join(created.sessionDir, 'projects', '-repo');
      await fs.mkdir(transcriptDir, { recursive: true });
      await fs.writeFile(path.join(transcriptDir, 'session-1.jsonl'), '{}\n', 'utf8');

      await MakaioBus.request(ClientSubjects.sessionConfig.destroy, { clientId: 'claude-code', leaseId });

      // Lease directory is gone, but the transcript survived in the store —
      // this is the property native resume across connector leases relies on.
      await expect(fs.stat(created.sessionDir)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(path.join(storeDir, '-repo', 'session-1.jsonl'), 'utf8')).resolves.toBe('{}\n');
    } finally {
      await fixture.release();
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  });
});
