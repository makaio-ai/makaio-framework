/**
 * Integration tests for the full detached-extension bus-stdio lifecycle, and
 * for the process lifecycle of a bus-websocket extension.
 *
 * These tests exercise the real subprocess spawn path:
 *   DetachedDescriptor → createDetachedExtensionPackage
 *     → BusStdioExtensionService.init()
 *       → StdioServerTransport (spawn tsx fixture)
 *         ↔ StdioClientTransport (in fixture process)
 *
 * A bus-websocket child connects back to the bus on its own; the tests here
 * cover the host's half with real `node -e` children (readiness on stdout, the
 * process group, the bounded stop and restarts) and answer the host's lifecycle
 * requests on the host bus itself.
 *
 * No mocks are used for transport or subprocess layers. Tests verify:
 * - Successful process spawn and subscribe-sync handshake.
 * - Transport registration in the host bus after init().
 * - Bidirectional event message flow (host → child → host echo).
 * - Clean teardown via destroy().
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createBusInstance, type BusTransport, type IMakaioBus } from '@makaio/bus-core';
import { busContextOf } from '@makaio/bus-core/kernel-api';
import type { DetachedDescriptor } from '@makaio/contracts/extension';
import type { NodeExtensionContext, ExtensionServiceLifecycle, ExtensionService } from '@makaio/contracts';
import { createBusNamespace } from '@makaio/core';
import { stubExtensionIdentity } from '@makaio/test-utils';
import { createDetachedExtensionPackage } from '../detached-extension-handle.js';
import { z } from 'zod';
import { useJournalHostFixture } from '@makaio/storage-conformance';

const { makeContext: makeStubNodeExtensionContext } = useJournalHostFixture();

// ---------------------------------------------------------------------------
// Fixture path
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FIXTURE_SCRIPT = path.join(FIXTURES_DIR, 'test-detached-extension.ts');

// ---------------------------------------------------------------------------
// Descriptor factory
// ---------------------------------------------------------------------------

/**
 * Build a {@link DetachedDescriptor} that spawns the test fixture via tsx.
 * @returns A minimal valid detached descriptor for the echo fixture.
 */
function makeTestDescriptor(): DetachedDescriptor {
  return {
    name: 'test-detached',
    displayName: 'Test Detached Extension',
    version: '1.0.0',
    makaio: { framework: '>=0.1.0' },
    execution: 'detached',
    transport: {
      type: 'bus-stdio',
      command: 'tsx',
      args: [FIXTURE_SCRIPT],
    },
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal context satisfying `NodeExtensionContext` for service creation.
 *
 * Only `bus` is exercised by `BusStdioExtensionService`; all other fields are
 * present to satisfy the interface but are inert stubs.
 * @param bus - Real bus instance to supply to the service.
 * @returns Minimal node extension context for testing.
 */
function makeTestContext(bus: ReturnType<typeof createBusInstance>): NodeExtensionContext<IMakaioBus> {
  return makeStubNodeExtensionContext(bus, {
    machineId: 'test-machine-id',
    dataDir: '/tmp/test-detached-ext',
    config: { enabled: true },
    identity: stubExtensionIdentity('test-detached'),
    platform: process.platform,
    homedir: '/tmp',
    makaioHome: '/tmp/.makaio',
    username: 'test',
  });
}

const LifecycleSubjects = createBusNamespace('extension.test-detached', {
  init: {
    request: z.object({
      config: z.unknown().optional(),
      context: z
        .object({
          dataDir: z.string().optional(),
          machineId: z.string().optional(),
          makaioHome: z.string().optional(),
          platform: z.string().optional(),
          username: z.string().optional(),
        })
        .optional(),
    }),
    response: z.object({ ready: z.boolean() }),
  },
  ready: z.object({
    ready: z.boolean(),
    config: z.unknown().optional(),
    context: z
      .object({
        dataDir: z.string().optional(),
        machineId: z.string().optional(),
        makaioHome: z.string().optional(),
        platform: z.string().optional(),
        username: z.string().optional(),
      })
      .optional(),
  }),
  destroy: {
    request: z.object({ reason: z.string().optional() }),
    response: z.object({ stopped: z.boolean() }),
  },
  stopped: z.object({ stopped: z.boolean() }),
}).subjects;

/**
 * Wait until a condition returns true, polling at a fixed interval.
 * Rejects after the timeout elapses without the condition being satisfied.
 * @param condition - Function returning true when the wait can end.
 * @param timeoutMs - Maximum wait time in milliseconds.
 * @param intervalMs - Polling interval in milliseconds.
 * @returns Promise resolving when condition is true.
 */
function waitFor(condition: () => boolean, timeoutMs = 5_000, intervalMs = 20): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const tick = (): void => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`waitFor: condition not met within ${timeoutMs}ms`));
        return;
      }
      setTimeout(tick, intervalMs);
    };

    tick();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

/**
 * Resolve the create() return value and narrow to lifecycle shape.
 * @param raw - Return value from pkg.create().
 * @returns Resolved lifecycle service.
 */
async function resolveService(raw: ExtensionService | Promise<ExtensionService>): Promise<ExtensionServiceLifecycle> {
  const resolved = await raw;
  return resolved as ExtensionServiceLifecycle;
}

describe('detached extension integration (bus-stdio)', () => {
  let service: ExtensionServiceLifecycle | undefined;

  afterEach(async () => {
    await service?.destroy?.();
    service = undefined;
  });

  it('init() spawns the child process and completes the subscribe-sync handshake', async () => {
    const bus = createBusInstance();
    const descriptor = makeTestDescriptor();
    const pkg = createDetachedExtensionPackage(descriptor, FIXTURES_DIR);
    const ctx = makeTestContext(bus);

    service = await resolveService(pkg.create!(ctx));
    await service.init!();

    // After init(), the transport must be registered in the bus context.
    const registeredTransports = busContextOf(bus).transportRegistry.all();
    expect(registeredTransports).toHaveLength(1);
    expect(registeredTransports[0]?.name).toBe('test-detached');
  }, 30_000);

  it('registered transport is ready after init()', async () => {
    const bus = createBusInstance();
    const descriptor = makeTestDescriptor();
    const pkg = createDetachedExtensionPackage(descriptor, FIXTURES_DIR);
    const ctx = makeTestContext(bus);

    service = await resolveService(pkg.create!(ctx));
    await service.init!();

    const [transport] = busContextOf(bus).transportRegistry.all();
    expect(transport).toBeDefined();
    // isReady() is true when the subscribe-sync handshake is complete.
    expect((transport as BusTransport & { isReady(): boolean }).isReady()).toBe(true);
  }, 30_000);

  it('init() sends the detached lifecycle init request with config and runtime context', async () => {
    const bus = createBusInstance();
    const descriptor = makeTestDescriptor();
    const pkg = createDetachedExtensionPackage(descriptor, FIXTURES_DIR);
    const ctx = makeTestContext(bus);
    const readyPayloads: unknown[] = [];
    bus.on(LifecycleSubjects.ready, (event) => {
      readyPayloads.push(event.payload);
    });

    service = await resolveService(pkg.create!(ctx));
    await service.init!();

    await waitFor(() => readyPayloads.length >= 1, 5_000);
    expect(readyPayloads[0]).toMatchObject({
      ready: true,
      config: { enabled: true },
      context: {
        dataDir: '/tmp/test-detached-ext',
        machineId: 'test-machine-id',
        makaioHome: '/tmp/.makaio',
        platform: process.platform,
        username: 'test',
      },
    });
  }, 30_000);

  it('routes an event through the bus to the child and receives the echo response', async () => {
    const bus = createBusInstance();
    const { subjects: TestSubjects } = bus.registerNamespace(
      createBusNamespace('test', {
        ping: z.object({ hello: z.string() }),
        pingEcho: z.object({ hello: z.string(), echoed: z.boolean() }),
      }),
    );
    const descriptor = makeTestDescriptor();
    const pkg = createDetachedExtensionPackage(descriptor, FIXTURES_DIR);
    const ctx = makeTestContext(bus);
    const received: Array<{ hello: string; echoed: boolean }> = [];
    bus.on(TestSubjects.pingEcho, (event) => {
      received.push(event.payload);
    });

    service = await resolveService(pkg.create!(ctx));
    await service.init!();

    const [transport] = busContextOf(bus).transportRegistry.all();
    expect(transport).toBeDefined();

    await bus.emit(TestSubjects.ping, { hello: 'world' });

    // Wait for the echo to arrive from the child.
    await waitFor(() => received.length >= 1, 5_000);

    expect(received[0]).toStrictEqual({
      hello: 'world',
      echoed: true,
    });
  }, 30_000);

  it('destroy() unregisters the transport and stops the child process', async () => {
    const bus = createBusInstance();
    const descriptor = makeTestDescriptor();
    const pkg = createDetachedExtensionPackage(descriptor, FIXTURES_DIR);
    const ctx = makeTestContext(bus);
    const stoppedPayloads: unknown[] = [];
    bus.on(LifecycleSubjects.stopped, (event) => {
      stoppedPayloads.push(event.payload);
    });

    service = await resolveService(pkg.create!(ctx));
    await service.init!();

    // Verify transport is registered before destroy.
    expect(busContextOf(bus).transportRegistry.all()).toHaveLength(1);

    await service.destroy!();
    service = undefined; // Prevent afterEach from calling destroy() again.

    await waitFor(() => stoppedPayloads.length >= 1, 5_000);
    expect(stoppedPayloads[0]).toStrictEqual({ stopped: true });

    // Transport must be removed from the registry.
    expect(busContextOf(bus).transportRegistry.all()).toHaveLength(0);
  }, 30_000);

  it('aborts a start that is waiting for the subscribe-sync handshake when the signal aborts, and stops the child', async () => {
    const workDir = mkdtempSync(path.join(tmpdir(), 'makaio-detached-stdio-'));
    const pidFile = path.join(workDir, 'pid');
    try {
      // A child that never takes part in the handshake: the host's `ready` never resolves.
      const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
      const descriptor: DetachedDescriptor = {
        ...makeTestDescriptor(),
        transport: {
          type: 'bus-stdio',
          command: process.execPath,
          args: ['-e', script],
          healthTimeoutMs: 30_000,
          shutdownTimeoutMs: 500,
        },
      };
      const pkg = createDetachedExtensionPackage(descriptor, FIXTURES_DIR);
      service = await resolveService(pkg.create!(makeTestContext(createBusInstance())));
      const controller = new AbortController();
      const cancelled = new Error('boot cancelled');

      const settled = outcomeOf(service.init!({ signal: controller.signal }));
      await waitFor(() => existsSync(pidFile));
      const pid = Number(readFileSync(pidFile, 'utf8'));
      const abortedAt = Date.now();
      controller.abort(cancelled);

      await expect(settled).resolves.toBe(cancelled);
      expect(Date.now() - abortedAt).toBeLessThan(5_000);
      service = undefined;
      await waitFor(() => !isAlive(pid), 5_000);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// bus-websocket
// ---------------------------------------------------------------------------

/**
 * A child that records its PID in the file named by `MAKAIO_TEST_PIDS` and
 * becomes ready. With `MAKAIO_TEST_GRANDCHILD` set it first starts a grandchild
 * in its process group and records that PID too. Its first run exits with code
 * 1 shortly after readiness when `MAKAIO_TEST_CRASH_ONCE` names a marker file
 * that does not exist yet.
 */
const WEBSOCKET_CHILD_SCRIPT = `
const fs = require('node:fs');
let grandchild = null;
if (process.env.MAKAIO_TEST_GRANDCHILD !== undefined) {
  const spawned = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  spawned.unref();
  grandchild = spawned.pid;
}
fs.writeFileSync(process.env.MAKAIO_TEST_PIDS, JSON.stringify({ pid: process.pid, grandchild }));
const marker = process.env.MAKAIO_TEST_CRASH_ONCE;
const crash = marker !== undefined && !fs.existsSync(marker);
if (crash) fs.writeFileSync(marker, 'crashed');
process.stdout.write('{"ready":true}\\n', () => { if (crash) setTimeout(() => process.exit(1), 100); });
setInterval(() => {}, 1000);
`;

/**
 * Build a bus-websocket descriptor for a `node -e` child.
 * @param script - Child source.
 * @param env - Child environment.
 * @param extra - Transport fields to override.
 * @returns A detached descriptor for the lifecycle under test.
 */
function makeWebSocketDescriptor(
  script: string,
  env: Record<string, string>,
  extra: { healthTimeoutMs?: number; restartPolicy?: 'none' | 'on-crash' | 'always' } = {},
): DetachedDescriptor {
  return {
    name: 'test-detached',
    displayName: 'Test Detached Extension',
    version: '1.0.0',
    makaio: { framework: '>=0.1.0' },
    execution: 'detached',
    transport: {
      type: 'bus-websocket',
      command: process.execPath,
      args: ['-e', script],
      env,
      healthTimeoutMs: 10_000,
      shutdownTimeoutMs: 500,
      ...extra,
    },
  };
}

/**
 * Settle a start into what it ended with.
 * @param start - The result of an `init()` call.
 * @returns `'resolved'`, or the reason the start rejected with.
 */
async function outcomeOf(start: void | Promise<void>): Promise<unknown> {
  try {
    await start;
    return 'resolved';
  } catch (error) {
    return error;
  }
}

/**
 * Report whether a process still exists; an unreaped zombie still counts.
 * @param pid - Process to probe.
 * @returns `false` once the process is gone.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

describe('detached extension integration (bus-websocket process lifecycle)', () => {
  let service: ExtensionServiceLifecycle | undefined;
  let workDir: string | undefined;
  const strayPids = new Set<number>();

  afterEach(async () => {
    await service?.destroy?.();
    service = undefined;
    for (const pid of strayPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    strayPids.clear();
    if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
    vi.restoreAllMocks();
  });

  /**
   * Create a bus that answers the lifecycle requests itself, and a service for `descriptor`.
   * @param descriptor - Descriptor of the extension under test.
   * @param failInitsFrom - 1-based number of the first init request the bus rejects; default: none.
   * @param holdInit - Whether the bus never answers the init requests; default: it answers them.
   * @returns The service and the init requests the bus received.
   */
  async function createService(
    descriptor: DetachedDescriptor,
    failInitsFrom = Number.POSITIVE_INFINITY,
    holdInit = false,
  ): Promise<{
    service: ExtensionServiceLifecycle;
    inits: unknown[];
  }> {
    const bus = createBusInstance();
    const inits: unknown[] = [];
    bus.on(LifecycleSubjects.init, async (request) => {
      inits.push(request.payload);
      if (holdInit) await new Promise<void>(() => undefined);
      // The n-th init request (1-based) and every later one is rejected.
      if (inits.length >= failInitsFrom) throw new Error('init rejected by test');
      request.setResult({ ready: true });
    });
    bus.on(LifecycleSubjects.destroy, (request) => {
      request.setResult({ stopped: true });
    });
    const ctx = { ...makeTestContext(bus), busUrl: 'ws://127.0.0.1:9' };
    const pkg = createDetachedExtensionPackage(descriptor, FIXTURES_DIR);
    return { service: await resolveService(pkg.create!(ctx)), inits };
  }

  /**
   * Read the PIDs the current child recorded, and register them for cleanup.
   * @param pidsFile - File named by `MAKAIO_TEST_PIDS`.
   * @returns The child's and the grandchild's PID.
   */
  function readPids(pidsFile: string): { pid: number; grandchild: number | null } {
    const pids = JSON.parse(readFileSync(pidsFile, 'utf8')) as { pid: number; grandchild: number | null };
    strayPids.add(pids.pid);
    if (pids.grandchild !== null) strayPids.add(pids.grandchild);
    return pids;
  }

  it('becomes ready on a JSON object, sends init once, and stops the whole group on destroy()', async () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'makaio-detached-ws-'));
    const pidsFile = path.join(workDir, 'pids.json');
    const created = await createService(
      makeWebSocketDescriptor(WEBSOCKET_CHILD_SCRIPT, { MAKAIO_TEST_PIDS: pidsFile, MAKAIO_TEST_GRANDCHILD: '1' }),
    );
    service = created.service;

    await service.init!();
    const { pid, grandchild } = readPids(pidsFile);
    expect(created.inits).toHaveLength(1);
    expect(isAlive(pid)).toBe(true);

    await service.destroy!();
    service = undefined;

    await waitFor(() => !isAlive(pid) && (grandchild === null || !isAlive(grandchild)), 5_000);
  }, 30_000);

  it('aborts a start that is waiting for readiness when the signal aborts, and stops the child at once', async () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'makaio-detached-ws-'));
    const pidsFile = path.join(workDir, 'pids.json');
    const script = `require('node:fs').writeFileSync(process.env.MAKAIO_TEST_PIDS, JSON.stringify({ pid: process.pid, grandchild: null })); setInterval(() => {}, 1000);`;
    const created = await createService(
      makeWebSocketDescriptor(script, { MAKAIO_TEST_PIDS: pidsFile }, { healthTimeoutMs: 30_000 }),
    );
    service = created.service;
    const controller = new AbortController();

    const settled = outcomeOf(service.init!({ signal: controller.signal }));
    await waitFor(() => existsSync(pidsFile));
    const { pid } = readPids(pidsFile);
    const abortedAt = Date.now();
    controller.abort(new Error('boot cancelled'));

    // Far inside the 30 s health timeout the start would otherwise run into.
    await expect(settled).resolves.toMatchObject({ message: expect.stringContaining('aborted by stop()') });
    expect(Date.now() - abortedAt).toBeLessThan(5_000);
    service = undefined;
    expect(created.inits).toHaveLength(0);
    await waitFor(() => !isAlive(pid), 5_000);
  }, 30_000);

  it('aborts a start that is waiting for the reply to its init request when the signal aborts, and stops the child', async () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'makaio-detached-ws-'));
    const pidsFile = path.join(workDir, 'pids.json');
    const created = await createService(
      makeWebSocketDescriptor(WEBSOCKET_CHILD_SCRIPT, { MAKAIO_TEST_PIDS: pidsFile }, { healthTimeoutMs: 30_000 }),
      Number.POSITIVE_INFINITY,
      true,
    );
    service = created.service;
    const controller = new AbortController();
    const cancelled = new Error('boot cancelled');

    const settled = outcomeOf(service.init!({ signal: controller.signal }));
    await waitFor(() => created.inits.length === 1);
    const { pid } = readPids(pidsFile);
    const abortedAt = Date.now();
    controller.abort(cancelled);

    await expect(settled).resolves.toBe(cancelled);
    expect(Date.now() - abortedAt).toBeLessThan(5_000);
    service = undefined;
    await waitFor(() => !isAlive(pid), 5_000);
  }, 30_000);

  it('fails init() at the health timeout when the readiness line is not a JSON object, and stops the child', async () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'makaio-detached-ws-'));
    const pidsFile = path.join(workDir, 'pids.json');
    const script = `require('node:fs').writeFileSync(process.env.MAKAIO_TEST_PIDS, JSON.stringify({ pid: process.pid, grandchild: null })); process.stdout.write('"ready"\\n'); setInterval(() => {}, 1000);`;
    const created = await createService(
      makeWebSocketDescriptor(script, { MAKAIO_TEST_PIDS: pidsFile }, { healthTimeoutMs: 1_000 }),
    );
    service = created.service;

    await expect(service.init!()).rejects.toThrow('health timeout');
    service = undefined;

    const { pid } = readPids(pidsFile);
    expect(created.inits).toHaveLength(0);
    await waitFor(() => !isAlive(pid), 5_000);
  }, 30_000);

  it('initialises a generation the restart policy started, and logs the crash that caused it', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    workDir = mkdtempSync(path.join(tmpdir(), 'makaio-detached-ws-'));
    const pidsFile = path.join(workDir, 'pids.json');
    const created = await createService(
      makeWebSocketDescriptor(
        WEBSOCKET_CHILD_SCRIPT,
        { MAKAIO_TEST_PIDS: pidsFile, MAKAIO_TEST_CRASH_ONCE: path.join(workDir, 'crashed') },
        { restartPolicy: 'on-crash' },
      ),
    );
    service = created.service;

    await service.init!();
    const first = readPids(pidsFile);
    expect(created.inits).toHaveLength(1);

    // The first generation crashes shortly after readiness and is restarted.
    await waitFor(() => created.inits.length === 2, 15_000);
    expect(readPids(pidsFile).pid).not.toBe(first.pid);
    expect(warnSpy.mock.calls.flat().join('\n')).toContain(
      '[extensions] test-detached: generation 1 ended unexpectedly: exited with code 1',
    );
  }, 30_000);

  it('stops a restarted generation whose init request fails, and reports the failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    workDir = mkdtempSync(path.join(tmpdir(), 'makaio-detached-ws-'));
    const pidsFile = path.join(workDir, 'pids.json');
    const created = await createService(
      makeWebSocketDescriptor(
        WEBSOCKET_CHILD_SCRIPT,
        { MAKAIO_TEST_PIDS: pidsFile, MAKAIO_TEST_CRASH_ONCE: path.join(workDir, 'crashed') },
        { restartPolicy: 'on-crash' },
      ),
      2,
    );
    service = created.service;

    await service.init!();
    const first = readPids(pidsFile);

    // Generation 1 crashes and is restarted; the init request of generation 2 fails.
    await waitFor(() => created.inits.length === 2, 15_000);
    const second = readPids(pidsFile);
    expect(second.pid).not.toBe(first.pid);

    // The generation that never received its configuration must not keep running.
    await waitFor(() => !isAlive(second.pid), 5_000);
    expect(errorSpy.mock.calls.flat().join('\n')).toContain('init of restarted generation 2 failed');
  }, 30_000);
});
