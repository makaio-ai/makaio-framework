/**
 * Integration tests for the full detached-extension bus-stdio lifecycle.
 *
 * These tests exercise the real subprocess spawn path:
 *   DetachedDescriptor → createDetachedExtensionPackage
 *     → BusStdioExtensionService.init()
 *       → StdioServerTransport (spawn tsx fixture)
 *         ↔ StdioClientTransport (in fixture process)
 *
 * No mocks are used for transport or subprocess layers. Tests verify:
 * - Successful process spawn and subscribe-sync handshake.
 * - Transport registration in the host bus after init().
 * - Bidirectional event message flow (host → child → host echo).
 * - Clean teardown via destroy().
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, afterEach } from 'vitest';
import { createBusInstance, type BusTransport } from '@makaio/bus-core';
import type { DetachedDescriptor } from '@makaio/contracts/extension';
import type { NodeExtensionContext, ExtensionServiceLifecycle, ExtensionService } from '@makaio/contracts';
import { createDetachedExtensionPackage } from '../detached-extension-handle.js';
import { z } from 'zod';

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
function makeTestContext(bus: ReturnType<typeof createBusInstance>): NodeExtensionContext {
  return {
    bus,
    machineId: 'test-machine-id',
    dataDir: '/tmp/test-detached-ext',
    config: { enabled: true },
    identity: {
      extensionName: 'test-detached',
    } as NodeExtensionContext['identity'],
    getService: () => undefined,
    tryImport: async () => null,
    signal: new AbortController().signal,
    hasExtension: () => false,
    platform: process.platform,
    homedir: '/tmp',
    makaioHome: '/tmp/.makaio',
    username: 'test',
  };
}

/**
 * Register the detached extension lifecycle namespace used by the fixture.
 * @param bus - Bus instance under test.
 * @returns Lifecycle subjects for the test detached extension.
 */
function registerLifecycleSubjects(bus: ReturnType<typeof createBusInstance>) {
  return bus.registerNamespace('extension.test-detached', {
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
}

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
    const registeredTransports = bus.getContext().transportRegistry.all();
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

    const [transport] = bus.getContext().transportRegistry.all();
    expect(transport).toBeDefined();
    // isReady() is true when the subscribe-sync handshake is complete.
    expect((transport as BusTransport & { isReady(): boolean }).isReady()).toBe(true);
  }, 30_000);

  it('init() sends the detached lifecycle init request with config and runtime context', async () => {
    const bus = createBusInstance();
    const LifecycleSubjects = registerLifecycleSubjects(bus);
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
    const { subjects: TestSubjects } = bus.registerNamespace('test', {
      ping: z.object({ hello: z.string() }),
      pingEcho: z.object({ hello: z.string(), echoed: z.boolean() }),
    });
    const descriptor = makeTestDescriptor();
    const pkg = createDetachedExtensionPackage(descriptor, FIXTURES_DIR);
    const ctx = makeTestContext(bus);
    const received: Array<{ hello: string; echoed: boolean }> = [];
    bus.on(TestSubjects.pingEcho, (event) => {
      received.push(event.payload);
    });

    service = await resolveService(pkg.create!(ctx));
    await service.init!();

    const [transport] = bus.getContext().transportRegistry.all();
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
    const LifecycleSubjects = registerLifecycleSubjects(bus);
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
    expect(bus.getContext().transportRegistry.all()).toHaveLength(1);

    await service.destroy!();
    service = undefined; // Prevent afterEach from calling destroy() again.

    await waitFor(() => stoppedPayloads.length >= 1, 5_000);
    expect(stoppedPayloads[0]).toStrictEqual({ stopped: true });

    // Transport must be removed from the registry.
    expect(bus.getContext().transportRegistry.all()).toHaveLength(0);
  }, 30_000);
});
