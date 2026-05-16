/**
 * Unit tests for the lazy runtime singleton in boot.ts.
 *
 * Full boot is integration-only (requires SQLite, adapters, etc.).
 * These tests cover the singleton's lifecycle invariants using a mocked
 * `bootMakaioRuntimeCore`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Mocking
// ---------------------------------------------------------------------------

const shutdownMock = vi.fn<() => Promise<void>>(() => Promise.resolve());
const bootMock = vi.fn(() => Promise.resolve({ shutdown: shutdownMock } as never));

vi.mock('@makaio/runtime-node', () => ({
  bootMakaioRuntimeCore: bootMock,
  normalizeNodeHostCapabilities: (caps?: readonly string[]) => ['node', ...(caps ?? [])],
  resolveMakaioHome: () => '/tmp/makaio-agent-sdk-test-home',
}));

vi.mock('@makaio/runtime-node/extension-discovery', () => ({
  FilesystemDescriptorDiscovery: class {
    public async discover() {
      return [];
    }
  },
  MergedDescriptorDiscovery: class {
    public constructor(private readonly discoveries: Array<{ discover: () => Promise<unknown[]> }>) {}

    public async discover() {
      return (await Promise.all(this.discoveries.map((discovery) => discovery.discover()))).flat();
    }
  },
}));

vi.mock('@makaio/contracts', () => ({
  parseExtensionDescriptor: (descriptor: unknown) => descriptor,
}));

vi.mock('@makaio/kernel/providers', () => ({
  NoTransportProvider: class {
    public async connect() {}
    public async disconnect() {}
  },
}));

vi.mock('@makaio/bus-core', () => ({
  MakaioBus: {},
}));

// ---------------------------------------------------------------------------
// Import subject under test AFTER mocks are in place
// ---------------------------------------------------------------------------

const { ensureRuntime, shutdownRuntime } = await import('../../../src/runtime/boot.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ensureRuntime', () => {
  beforeEach(() => {
    bootMock.mockClear();
    shutdownMock.mockClear();
  });

  afterEach(async () => {
    // Always reset the singleton between tests.
    await shutdownRuntime();
    bootMock.mockClear();
    shutdownMock.mockClear();
  });

  it('boots the runtime on the first call', async () => {
    await ensureRuntime();

    expect(bootMock).toHaveBeenCalledTimes(1);
  });

  it('boots with bundled runtime package discovery layered into boot options', async () => {
    await ensureRuntime();

    const firstBootCall = bootMock.mock.calls[0] as unknown[] | undefined;
    const options = firstBootCall?.[3] as
      | { discovery?: { discover: () => Promise<Array<{ descriptor: { name: string } }>> } }
      | undefined;
    const discovered = await options?.discovery?.discover();

    expect(discovered?.map((extension) => extension.descriptor.name)).toEqual(
      expect.arrayContaining(['anthropic-sdk', 'openai-node', 'provider-openai', 'filesystem', 'shell', 'subagent']),
    );
  });

  it('returns the MakaioBus singleton', async () => {
    const bus = await ensureRuntime();

    // The bus export from @makaio/bus-core is the singleton object.
    expect(bus).toBeDefined();
  });

  it('reuses the same runtime on subsequent calls', async () => {
    await ensureRuntime();
    await ensureRuntime();
    await ensureRuntime();

    expect(bootMock).toHaveBeenCalledTimes(1);
  });

  it('concurrent calls share one boot promise', async () => {
    await Promise.all([ensureRuntime(), ensureRuntime(), ensureRuntime()]);

    expect(bootMock).toHaveBeenCalledTimes(1);
  });

  it('retries boot after a failed attempt', async () => {
    bootMock.mockRejectedValueOnce(new Error('boot failed'));

    await expect(ensureRuntime()).rejects.toThrow('boot failed');

    bootMock.mockResolvedValueOnce({ shutdown: shutdownMock } as never);
    await expect(ensureRuntime()).resolves.toBeDefined();
    expect(bootMock).toHaveBeenCalledTimes(2);
  });

  it('failed boot clears only its own promise, not a replacement set after shutdown', async () => {
    // Scenario: boot 1 fails, shutdownRuntime clears the slot (bootPromise = null),
    // a new ensureRuntime call immediately sets a new bootPromise (p2), and THEN
    // boot 1's catch handler fires. Without an identity check the catch handler
    // would erase p2, causing the next ensureRuntime to boot a third runtime.
    //
    // The catch handler uses `if (bootPromise === currentPromise)` to guard
    // against exactly this: it only clears the slot when it is still its own.

    let rejectFirstBoot!: (err: unknown) => void;
    const firstBootBarrier = new Promise<never>((_, reject) => {
      rejectFirstBoot = reject;
    });
    bootMock.mockImplementationOnce(() => firstBootBarrier);
    bootMock.mockResolvedValueOnce({ shutdown: shutdownMock } as never);

    // Start boot 1 (will fail) — not awaited yet.
    const firstCall = ensureRuntime();

    // Let the failure propagate so the catch handler fires, but before it can
    // run we need to insert a new boot into the same slot.
    //
    // We achieve this by: (1) rejecting the barrier, (2) yielding via await so
    // microtasks run but pausing at the point where catch might fire,
    // (3) calling shutdownRuntime + ensureRuntime to put p2 into the slot.
    //
    // In practice: rejectFirstBoot schedules a microtask. If we call
    // shutdownRuntime (which clears bootPromise=null) in the same microtask
    // checkpoint before the catch fires, then ensureRuntime sets p2.
    // The catch handler then sees bootPromise !== firstBootBarrier and leaves p2 alone.

    rejectFirstBoot(new Error('first boot failed'));

    // Allow the rejection microtask to be queued but not yet consumed.
    // Then synchronously slot in the replacement before the catch runs.
    // We simulate the interleaving by calling shutdownRuntime() + ensureRuntime()
    // before any await — their synchronous portions run before the rejection
    // microtask fires.
    //
    // shutdownRuntime() sets bootPromise = null synchronously (before its own await).
    const shutdownPromiseP = shutdownRuntime(); // sets bootPromise = null immediately in sync portion
    const secondCall = ensureRuntime(); // sets bootPromise = p2 synchronously

    // Now let everything settle.
    await expect(firstCall).rejects.toThrow('first boot failed');
    await shutdownPromiseP;
    // Boot 1's failed shutdown (boot had already failed) is a no-op.
    await expect(secondCall).resolves.toBeDefined();

    // One boot for the failing run, one for the successful replacement.
    expect(bootMock).toHaveBeenCalledTimes(2);
  });
});

describe('shutdownRuntime', () => {
  beforeEach(() => {
    bootMock.mockClear();
    shutdownMock.mockClear();
  });

  afterEach(async () => {
    // Reset state in case a test left the runtime running.
    await shutdownRuntime();
    bootMock.mockClear();
    shutdownMock.mockClear();
  });

  it('calls shutdown on the runtime when it was booted', async () => {
    await ensureRuntime();
    await shutdownRuntime();

    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when no runtime was started', async () => {
    await shutdownRuntime();

    expect(shutdownMock).not.toHaveBeenCalled();
  });

  it('is idempotent — second call is a no-op', async () => {
    await ensureRuntime();
    await shutdownRuntime();
    await shutdownRuntime();

    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('concurrent callers share the active shutdown promise', async () => {
    await ensureRuntime();

    const barrier = { resolve: (() => {}) as () => void };
    shutdownMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          barrier.resolve = resolve;
        }),
    );

    const firstShutdown = shutdownRuntime();
    await Promise.resolve();

    let secondSettled = false;
    const secondShutdown = shutdownRuntime().then(() => {
      secondSettled = true;
    });
    await Promise.resolve();

    expect(secondSettled).toBe(false);

    barrier.resolve();
    await Promise.all([firstShutdown, secondShutdown]);

    expect(secondSettled).toBe(true);
    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('allows a new runtime to boot after shutdown', async () => {
    await ensureRuntime();
    await shutdownRuntime();
    await ensureRuntime();

    expect(bootMock).toHaveBeenCalledTimes(2);
  });

  it('ensureRuntime called during shutdown waits for teardown before booting', async () => {
    // Boot the runtime.
    await ensureRuntime();

    // Slow down the shutdown so ensureRuntime can race against it.
    // The resolver is captured via a shared object so the closure is updated
    // before shutdownMock is awaited (the assignment happens inside the
    // Promise constructor which runs synchronously).
    const barrier = { resolve: (() => {}) as () => void };
    shutdownMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          barrier.resolve = resolve;
        }),
    );

    // Start shutdown but don't await it.
    const shutdownDone = shutdownRuntime();

    // Yield once so the async IIFE inside shutdownRuntime reaches the
    // `runtime.shutdown()` call, causing the barrier Promise constructor to
    // run and populate barrier.resolve.
    await Promise.resolve();

    // Immediately request a new runtime — must wait for shutdown to complete.
    const bootDone = ensureRuntime();

    // Unblock the shutdown.
    barrier.resolve();

    await shutdownDone;
    await bootDone;

    // The second boot must only happen after shutdown finished.
    expect(shutdownMock).toHaveBeenCalledTimes(1);
    expect(bootMock).toHaveBeenCalledTimes(2);
  });
});

describe('runtime integration (requires MAKAIO_TEST_RUNTIME)', () => {
  it.skipIf(!process.env['MAKAIO_TEST_RUNTIME'])('boots a real embedded runtime', async () => {
    const { ensureRuntime: ensureReal, shutdownRuntime: shutdownReal } = await import('../../../src/runtime/boot.js');

    const bus = await ensureReal();
    try {
      expect(bus).toBeDefined();
    } finally {
      await shutdownReal();
    }
  });
});

describe('@makaio/agent-sdk package exports', () => {
  it('defines root, core, and runtime entry exports for development and publishing', async () => {
    const raw = await readFile(new URL('../../../package.json', import.meta.url), 'utf8');
    const pkg = JSON.parse(raw) as {
      exports?: Record<string, unknown>;
      publishConfig?: { exports?: Record<string, unknown> };
    };

    expect(pkg.exports).toMatchObject({
      '.': './src/shared/index.ts',
      './core': './src/core/index.ts',
      './runtime': './src/runtime/index.ts',
    });
    expect(pkg.publishConfig?.exports).toMatchObject({
      '.': {
        types: './dist/shared/index.d.mts',
        import: './dist/shared/index.mjs',
      },
      './core': {
        types: './dist/core/index.d.mts',
        import: './dist/core/index.mjs',
      },
      './runtime': {
        types: './dist/runtime/index.d.mts',
        import: './dist/runtime/index.mjs',
      },
    });
  });
});
