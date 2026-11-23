import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, DEFAULT_REQUEST_TIMEOUT_MS } from '@makaio/bus-core';
import { ownerOf } from '@makaio/bus-core/kernel-api';
import type { DetachedDescriptor, ExtensionServiceLifecycle } from '@makaio/contracts/extension';
import { processStopBudgetMs } from '@makaio/subprocess';
import { makeStubNodeExtensionContext, stubExtensionIdentity } from '@makaio/test-utils';
import { createDetachedExtensionPackage } from '../detached-extension-handle.js';
import { isMakaioExtensionLike } from '../load-extensions.js';

const subprocessMocks = vi.hoisted(() => ({
  createProcessLifecycle: vi.fn(),
}));

vi.mock('@makaio/subprocess', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@makaio/subprocess')>()),
  createProcessLifecycle: subprocessMocks.createProcessLifecycle,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid {@link DetachedDescriptor} for `bus-stdio`.
 * @param overrides - Partial fields to merge into the base descriptor.
 */
function makeBusStdioDescriptor(overrides: Partial<DetachedDescriptor> = {}): DetachedDescriptor {
  return {
    name: 'my-detached-ext',
    displayName: 'My Detached Extension',
    version: '1.0.0',
    makaio: { framework: '>=1.0.0' },
    execution: 'detached',
    transport: { type: 'bus-stdio', command: 'node', args: ['ext.js'] },
    ...overrides,
  };
}

/**
 * Build a minimal valid {@link DetachedDescriptor} for `bus-websocket`.
 * @param overrides - Partial fields to merge into the base descriptor.
 */
function makeBusWebSocketDescriptor(overrides: Partial<DetachedDescriptor> = {}): DetachedDescriptor {
  return {
    name: 'my-ws-ext',
    displayName: 'My WebSocket Extension',
    version: '1.0.0',
    makaio: { framework: '>=1.0.0' },
    execution: 'detached',
    transport: { type: 'bus-websocket', command: 'node', args: ['ws-ext.js'] },
    ...overrides,
  };
}

/**
 * Build a minimal valid {@link DetachedDescriptor} for `mcp-stdio`.
 * @param overrides - Partial fields to merge into the base descriptor.
 */
function makeMcpStdioDescriptor(overrides: Partial<DetachedDescriptor> = {}): DetachedDescriptor {
  return {
    name: 'my-mcp-ext',
    displayName: 'My MCP Extension',
    version: '1.0.0',
    makaio: { framework: '>=1.0.0' },
    execution: 'detached',
    transport: { type: 'mcp-stdio', command: 'node', args: ['mcp-ext.js'] },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shape tests — no processes are spawned
// ---------------------------------------------------------------------------

/** Stable fake extension root used in all shape tests — no filesystem access needed. */
const FAKE_EXTENSION_PATH = '/fake/ext/path';

describe('createDetachedExtensionPackage', () => {
  beforeEach(() => {
    subprocessMocks.createProcessLifecycle.mockReset();
  });

  describe('MakaioExtension shape', () => {
    it('returns an object with name and displayName matching the descriptor', () => {
      const descriptor = makeBusStdioDescriptor();
      const pkg = createDetachedExtensionPackage(descriptor, FAKE_EXTENSION_PATH);

      expect(pkg.name).toBe('my-detached-ext');
      expect(pkg.displayName).toBe('My Detached Extension');
    });

    it('passes the isMakaioExtensionLike structural check', () => {
      const pkg = createDetachedExtensionPackage(makeBusStdioDescriptor(), FAKE_EXTENSION_PATH);

      expect(isMakaioExtensionLike(pkg)).toBe(true);
    });

    it('exposes a create function', () => {
      const pkg = createDetachedExtensionPackage(makeBusStdioDescriptor(), FAKE_EXTENSION_PATH);

      expect(typeof pkg.create).toBe('function');
    });
  });

  describe('descriptor field propagation', () => {
    it('propagates surface when set on the descriptor', () => {
      const descriptor = makeBusStdioDescriptor({ surface: 'headless' });
      const pkg = createDetachedExtensionPackage(descriptor, FAKE_EXTENSION_PATH);

      expect(pkg.surface).toBe('headless');
    });

    it('omits surface when not set on the descriptor', () => {
      const descriptor = makeBusStdioDescriptor();
      const pkg = createDetachedExtensionPackage(descriptor, FAKE_EXTENSION_PATH);

      expect('surface' in pkg).toBe(false);
    });

    it('propagates dependencies when set on the descriptor', () => {
      const dep = { type: 'extension' as const, name: 'other-ext', version: '>=1.0.0' as const };
      const descriptor = makeBusStdioDescriptor({ dependencies: [dep] });
      const pkg = createDetachedExtensionPackage(descriptor, FAKE_EXTENSION_PATH);

      expect(pkg.dependencies).toStrictEqual([dep]);
    });

    it('omits dependencies when not set on the descriptor', () => {
      const descriptor = makeBusStdioDescriptor();
      const pkg = createDetachedExtensionPackage(descriptor, FAKE_EXTENSION_PATH);

      expect('dependencies' in pkg).toBe(false);
    });

    it('propagates capability gates from the descriptor manifest', () => {
      const descriptor = makeBusStdioDescriptor({
        requires: [{ type: 'capability', id: 'node' }],
        provides: ['adapters'],
      });
      const pkg = createDetachedExtensionPackage(descriptor, FAKE_EXTENSION_PATH);

      expect(pkg.requires).toStrictEqual([{ type: 'capability', id: 'node' }]);
      expect(pkg.provides).toStrictEqual(['adapters']);
    });
  });

  describe('create() factory', () => {
    it('returns an object with init and destroy methods for bus-stdio', () => {
      const pkg = createDetachedExtensionPackage(makeBusStdioDescriptor(), FAKE_EXTENSION_PATH);
      const mockCtx = { bus: {} } as Parameters<NonNullable<typeof pkg.create>>[0];
      const service = pkg.create!(mockCtx) as ExtensionServiceLifecycle;

      expect(typeof service.init).toBe('function');
      expect(typeof service.destroy).toBe('function');
    });

    it('returns an object with init and destroy methods for bus-websocket', () => {
      const pkg = createDetachedExtensionPackage(makeBusWebSocketDescriptor(), FAKE_EXTENSION_PATH);
      const mockCtx = { bus: {} } as Parameters<NonNullable<typeof pkg.create>>[0];
      const service = pkg.create!(mockCtx) as ExtensionServiceLifecycle;

      expect(typeof service.init).toBe('function');
      expect(typeof service.destroy).toBe('function');
    });

    it('returns an object with init and destroy methods for mcp-stdio', () => {
      const pkg = createDetachedExtensionPackage(makeMcpStdioDescriptor(), FAKE_EXTENSION_PATH);
      const mockCtx = { bus: {} } as Parameters<NonNullable<typeof pkg.create>>[0];
      const service = pkg.create!(mockCtx) as ExtensionServiceLifecycle;

      expect(typeof service.init).toBe('function');
      expect(typeof service.destroy).toBe('function');
    });

    it('destroy() on a never-started bus-websocket service resolves without error', async () => {
      const pkg = createDetachedExtensionPackage(makeBusWebSocketDescriptor(), FAKE_EXTENSION_PATH);
      const mockCtx = { bus: {} } as Parameters<NonNullable<typeof pkg.create>>[0];
      const service = pkg.create!(mockCtx) as ExtensionServiceLifecycle;

      await expect(service.destroy?.()).resolves.toBeUndefined();
    });

    it('requires a host bus URL before starting bus-websocket children', async () => {
      const pkg = createDetachedExtensionPackage(makeBusWebSocketDescriptor(), FAKE_EXTENSION_PATH);
      const mockCtx = { bus: {} } as Parameters<NonNullable<typeof pkg.create>>[0];
      const service = pkg.create!(mockCtx) as ExtensionServiceLifecycle;

      await expect(service.init?.()).rejects.toThrow('bus-websocket transport requires NodeExtensionContext.busUrl');
      expect(subprocessMocks.createProcessLifecycle).not.toHaveBeenCalled();
    });

    it('injects bus-websocket connection environment and runs lifecycle init', async () => {
      const start = vi.fn().mockResolvedValue(undefined);
      const stop = vi.fn().mockResolvedValue(undefined);
      subprocessMocks.createProcessLifecycle.mockReturnValue({
        start,
        stop,
        state: 'idle',
        transport: undefined,
      });
      const bus = createBusInstance();
      const request = vi.spyOn(bus, 'request').mockResolvedValue({ ready: true } as never);
      const pkg = createDetachedExtensionPackage(
        makeBusWebSocketDescriptor({
          transport: {
            type: 'bus-websocket',
            command: 'node',
            args: ['ws-ext.js'],
            env: { CHILD_ENV: '1', MAKAIO_BUS_URL: 'ignored-child-url' },
          },
        }),
        FAKE_EXTENSION_PATH,
      );
      const mockCtx = makeStubNodeExtensionContext(bus, {
        busUrl: 'ws://127.0.0.1:1234/bus',
        config: { enabled: true },
        dataDir: '/tmp/my-ws-ext',
        homedir: '/tmp',
        identity: stubExtensionIdentity('my-ws-ext'),
        machineId: 'machine-1',
        makaioHome: '/tmp/.makaio',
        platform: process.platform,
        username: 'test',
      });
      const lease = vi.spyOn(mockCtx.namespaces, 'lease');
      const service = pkg.create!(mockCtx) as ExtensionServiceLifecycle;

      await service.init?.();
      await service.destroy?.();

      expect(subprocessMocks.createProcessLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({
          spawn: expect.objectContaining({
            env: expect.objectContaining({
              CHILD_ENV: '1',
              MAKAIO_BUS_TRANSPORT: 'websocket',
              MAKAIO_BUS_URL: 'ws://127.0.0.1:1234/bus',
              MAKAIO_EXTENSION_NAME: 'my-ws-ext',
            }),
          }),
        }),
      );
      expect(start).toHaveBeenCalledOnce();
      expect(stop).toHaveBeenCalledOnce();
      expect(ownerOf(bus, 'extension.my-ws-ext')).toEqual({ kind: 'extension', extension: 'my-ws-ext' });
      expect(lease).toHaveBeenCalledOnce();
      // ORIGIN: Match the context minted for detached startup.
      expect(request).toHaveBeenCalledWith(
        bus.own('start'),
        expect.anything(),
        expect.objectContaining({ config: { enabled: true } }),
        expect.objectContaining({ timeout: undefined }),
      );
      // ORIGIN: Match the context minted for detached teardown.
      expect(request).toHaveBeenCalledWith(
        bus.own('stop'),
        expect.anything(),
        { reason: 'runtime-shutdown' },
        expect.objectContaining({ timeout: DEFAULT_REQUEST_TIMEOUT_MS }),
      );
      expect(subprocessMocks.createProcessLifecycle).toHaveBeenCalledWith(
        expect.objectContaining({ stopTiming: { killGraceMs: undefined } }),
      );
    });

    it('destroy() on a never-started mcp-stdio service resolves without error', async () => {
      const pkg = createDetachedExtensionPackage(makeMcpStdioDescriptor(), FAKE_EXTENSION_PATH);
      const mockCtx = { bus: {} } as Parameters<NonNullable<typeof pkg.create>>[0];
      const service = pkg.create!(mockCtx) as ExtensionServiceLifecycle;

      await expect(service.destroy?.()).resolves.toBeUndefined();
    });
  });

  describe('stop budget', () => {
    /**
     * Create the service of a descriptor.
     * @param descriptor - Detached descriptor.
     * @returns The service the extension's `create` returns.
     */
    function serviceOf(descriptor: DetachedDescriptor): ExtensionServiceLifecycle {
      const pkg = createDetachedExtensionPackage(descriptor, FAKE_EXTENSION_PATH);
      return pkg.create!({ bus: {} } as Parameters<NonNullable<typeof pkg.create>>[0]) as ExtensionServiceLifecycle;
    }

    it.each([
      ['bus-stdio', makeBusStdioDescriptor],
      ['bus-websocket', makeBusWebSocketDescriptor],
    ])('adds the destroy request window to the stop of the %s child, both set by shutdownTimeoutMs', (_, make) => {
      const base = make();
      const service = serviceOf({
        ...base,
        transport: { ...base.transport, shutdownTimeoutMs: 1_000 },
      });

      expect(service.stopBudgetMs).toBe(1_000 + processStopBudgetMs({ killGraceMs: 1_000 }));
    });

    it('runs the destroy request under the bus default when no window is declared', () => {
      expect(serviceOf(makeBusWebSocketDescriptor()).stopBudgetMs).toBe(
        DEFAULT_REQUEST_TIMEOUT_MS + processStopBudgetMs(),
      );
    });

    it('declares none for an mcp-stdio child, whose MCP client keeps its own stop contract', () => {
      expect(serviceOf(makeMcpStdioDescriptor()).stopBudgetMs).toBeUndefined();
    });
  });

  describe('transport type dispatch', () => {
    it('creates distinct service instances for bus-stdio vs bus-websocket', () => {
      const mockCtx = { bus: {} } as Parameters<
        NonNullable<ReturnType<typeof createDetachedExtensionPackage>['create']>
      >[0];

      const stdioPkg = createDetachedExtensionPackage(makeBusStdioDescriptor(), FAKE_EXTENSION_PATH);
      const wsPkg = createDetachedExtensionPackage(makeBusWebSocketDescriptor(), FAKE_EXTENSION_PATH);

      const stdioService = stdioPkg.create!(mockCtx) as ExtensionServiceLifecycle;
      const wsService = wsPkg.create!(mockCtx) as ExtensionServiceLifecycle;

      // Both expose the lifecycle interface
      expect(typeof stdioService.init).toBe('function');
      expect(typeof wsService.init).toBe('function');

      // They are different object instances
      expect(stdioService).not.toBe(wsService);
    });
  });
});
