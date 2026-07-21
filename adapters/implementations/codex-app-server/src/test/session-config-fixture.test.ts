import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus, RequestError } from '@makaio/bus-core';
import { CodexClientSessionService, CodexClientSubjects } from '@makaio/client-codex/runtime';
import { ClientSubjects } from '@makaio/contracts/client';
import {
  acquireCodexConformanceSessionConfigFixture,
  closeCodexConformanceResources,
} from './session-config-fixture.js';

const FIXTURE_ROOT_PREFIX = 'makaio-codex-conformance-config-';

afterEach(() => {
  vi.restoreAllMocks();
  MakaioBus.__resetHandlers?.();
});

/** Start a fixture without the client-owned handlers so tests can inject boundary failures. */
async function acquireHandlerlessFixture(): Promise<
  Awaited<ReturnType<typeof acquireCodexConformanceSessionConfigFixture>>
> {
  vi.spyOn(CodexClientSessionService.prototype, 'init').mockResolvedValue();
  vi.spyOn(CodexClientSessionService.prototype, 'destroy').mockResolvedValue();
  return acquireCodexConformanceSessionConfigFixture();
}

describe('Codex conformance session-config fixture lifecycle', () => {
  it('removes a newly created lease directory when client-owned setup fails', { timeout: 10_000 }, async () => {
    const fixture = await acquireHandlerlessFixture();
    const leaseId = 'failed-setup-lease';
    let sessionDir: string | undefined;
    const unsubscribeSetup = MakaioBus.on(CodexClientSubjects.sessionConfig.setup, (ctx) => {
      sessionDir = ctx.payload.sessionDir;
      throw new Error('client setup failed');
    });

    try {
      await expect(
        MakaioBus.request(ClientSubjects.sessionConfig.create, {
          clientId: 'codex',
          leaseId,
          projectDir: os.tmpdir(),
          configInheritance: 'empty',
        }),
      ).rejects.toThrow();
      if (sessionDir === undefined) throw new Error('Client setup did not expose its lease directory.');
      await expect(fs.stat(sessionDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      unsubscribeSetup();
      await fixture.release();
    }
  });

  it('preserves client teardown and directory-removal failures in one aggregate', async () => {
    const fixture = await acquireHandlerlessFixture();
    const unsubscribeSetup = MakaioBus.on(CodexClientSubjects.sessionConfig.setup, (ctx) => {
      ctx.setResult({ env: { CODEX_HOME: ctx.payload.sessionDir }, authMaterialized: false });
    });
    const unsubscribeDestroy = MakaioBus.on(CodexClientSubjects.sessionConfig.destroy, () => {
      throw new Error('client teardown failed');
    });
    const created = await MakaioBus.request(ClientSubjects.sessionConfig.create, {
      clientId: 'codex',
      leaseId: 'dual-failure-lease',
      projectDir: os.tmpdir(),
      configInheritance: 'empty',
    });
    const originalRemove = fs.rm.bind(fs);
    const removeSpy = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (path.resolve(target.toString()) === path.resolve(created.sessionDir)) {
        throw new Error('lease directory removal failed');
      }
      return originalRemove(target, options);
    });

    let destroyError: unknown;
    try {
      await MakaioBus.request(ClientSubjects.sessionConfig.destroy, {
        clientId: 'codex',
        leaseId: 'dual-failure-lease',
      });
    } catch (error) {
      destroyError = error;
    }
    const removalAttempted = removeSpy.mock.calls.some(
      ([target, options]) => target === created.sessionDir && options?.recursive === true && options.force === true,
    );

    removeSpy.mockRestore();
    unsubscribeSetup();
    unsubscribeDestroy();
    await originalRemove(created.sessionDir, { recursive: true, force: true });
    await fixture.release();

    expect(destroyError).toBeInstanceOf(RequestError);
    expect((destroyError as RequestError).cause).toBeInstanceOf(AggregateError);
    expect(((destroyError as RequestError).cause as AggregateError).errors).toHaveLength(2);
    expect(removalAttempted).toBe(true);
  });

  it('attempts root removal and aggregates it with a service shutdown failure', async () => {
    const fixture = await acquireHandlerlessFixture();
    vi.mocked(CodexClientSessionService.prototype.destroy).mockRejectedValueOnce(new Error('service shutdown failed'));
    const originalRemove = fs.rm.bind(fs);
    const removeSpy = vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('fixture root removal failed'));

    let releaseError: unknown;
    try {
      await fixture.release();
    } catch (error) {
      releaseError = error;
    }

    expect(releaseError).toBeInstanceOf(AggregateError);
    expect((releaseError as AggregateError).errors).toHaveLength(2);
    const removedRoot = removeSpy.mock.calls[0]?.[0].toString();
    expect(path.dirname(removedRoot ?? '')).toBe(os.tmpdir());
    expect(path.basename(removedRoot ?? '').startsWith(FIXTURE_ROOT_PREFIX)).toBe(true);

    removeSpy.mockRestore();
    if (removedRoot !== undefined) {
      await originalRemove(removedRoot, { recursive: true, force: true });
    }
  });

  it('aggregates runtime-close and fixture-release failures without skipping either stage', async () => {
    const closeRuntimes = vi.fn().mockRejectedValue(new Error('runtime close failed'));
    const release = vi.fn().mockRejectedValue(new Error('fixture release failed'));

    await expect(closeCodexConformanceResources(closeRuntimes, { release })).rejects.toMatchObject({
      errors: expect.arrayContaining([expect.any(Error), expect.any(Error)]),
    });
    expect(closeRuntimes).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
