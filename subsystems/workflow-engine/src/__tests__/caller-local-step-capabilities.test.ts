import { access, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createBusInstance } from '@makaio/bus-core';
import { createLocalLauncher } from '@makaio/subprocess';
import { createTestCall } from '@makaio/test-utils';
import { expect, it, vi } from 'vitest';
import { bindCallerLocalStepCapabilities } from '../runtime/caller-local-step-capabilities.js';

vi.mock('@makaio/subprocess', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@makaio/subprocess')>();
  return {
    ...actual,
    createLocalLauncher: vi.fn((setup: Parameters<typeof createLocalLauncher>[0]) => {
      const site = actual.createLocalLauncher(setup);
      return {
        ...site,
        launcher: {
          boundary: site.launcher.boundary,
          launch: site.launcher.launch.bind(site.launcher),
          closeAll: site.launcher.closeAll.bind(site.launcher),
          closeOwner: async () => ({ kind: 'unproven', boundary: 'process-group', reason: 'termination-unconfirmed' }),
        },
      } satisfies ReturnType<typeof createLocalLauncher>;
    }),
  };
});

it('removes its workspace when owner closure cannot be confirmed', async () => {
  const capabilities = bindCallerLocalStepCapabilities({
    bus: createBusInstance(),
    call: createTestCall(),
    signal: new AbortController().signal,
    env: {},
    workspace: process.cwd(),
    stepId: 'cleanup-step',
  });
  const launch = await capabilities.launchProcess({ program: process.execPath, args: [], cwd: '..', stdin: 'none' });
  const setup = vi.mocked(createLocalLauncher).mock.lastCall?.[0];
  if (setup === undefined) throw new Error('Expected a real local launch site');
  const directory = dirname(setup.stepHomeRoot);
  try {
    expect(launch).toMatchObject({
      ok: false,
      code: process.platform === 'win32' ? 'unsupported-site' : 'cwd-outside-workspace',
    });
    await expect(capabilities.close()).rejects.toThrow('Local step process closure could not be confirmed');
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
