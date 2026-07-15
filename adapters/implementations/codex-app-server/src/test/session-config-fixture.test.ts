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

/** List worker-visible Codex conformance fixture roots. */
async function listFixtureRoots(): Promise<Set<string>> {
  const entries = await fs.readdir(os.tmpdir(), { withFileTypes: true });
  return new Set(
    entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(FIXTURE_ROOT_PREFIX))
      .map((entry) => path.join(os.tmpdir(), entry.name)),
  );
}

/**
 * Resolve the one fixture root created after the provided snapshot.
 * @param previous - Fixture roots visible before acquisition
 * @returns Newly created fixture root
 */
async function resolveNewFixtureRoot(previous: ReadonlySet<string>): Promise<string> {
  const roots = [...(await listFixtureRoots())].filter((root) => !previous.has(root));
  expect(roots).toHaveLength(1);
  return roots[0] as string;
}

/** Start a fixture without the client-owned handlers so tests can inject boundary failures. */
async function acquireHandlerlessFixture(): Promise<{
  readonly fixture: Awaited<ReturnType<typeof acquireCodexConformanceSessionConfigFixture>>;
  readonly root: string;
}> {
  vi.spyOn(CodexClientSessionService.prototype, 'init').mockResolvedValue();
  vi.spyOn(CodexClientSessionService.prototype, 'destroy').mockResolvedValue();
  const previousRoots = await listFixtureRoots();
  const fixture = await acquireCodexConformanceSessionConfigFixture();
  return { fixture, root: await resolveNewFixtureRoot(previousRoots) };
}

describe('Codex conformance session-config fixture lifecycle', () => {
  it('removes a newly created lease directory when client-owned setup fails', { timeout: 10_000 }, async () => {
    const { fixture, root } = await acquireHandlerlessFixture();
    const leaseId = 'failed-setup-lease';
    const sessionDir = path.join(root, 'codex', 'sessions', leaseId);

    await expect(
      MakaioBus.request(ClientSubjects.sessionConfig.create, {
        clientId: 'codex',
        leaseId,
        projectDir: os.tmpdir(),
        configInheritance: 'empty',
      }),
    ).rejects.toThrow();
    await expect(fs.stat(sessionDir)).rejects.toMatchObject({ code: 'ENOENT' });

    await fixture.release();
  });

  it('preserves client teardown and directory-removal failures in one aggregate', async () => {
    const { fixture } = await acquireHandlerlessFixture();
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
    const { fixture, root } = await acquireHandlerlessFixture();
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
    expect(removeSpy).toHaveBeenCalledWith(root, { recursive: true, force: true });

    removeSpy.mockRestore();
    await originalRemove(root, { recursive: true, force: true });
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
