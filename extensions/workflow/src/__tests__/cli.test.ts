/**
 * Tests for the workflow CLI contribution declaration.
 *
 * Verifies structural invariants of the contribution object — `canProvideBus`,
 * `provideBus`, and `beforeRun` — plus the options passed to
 * `bootMakaioRuntimeCore` by `bootEmbeddedWorkflowRuntime`.
 *
 * Full runtime boot is integration-only (requires SQLite, file system, etc.).
 * These tests use a mocked `bootMakaioRuntimeCore` to assert the boot options
 * without exercising the full startup sequence.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { IMakaioBus } from '@makaio/bus-core';
import type { CoreBootOptions, MakaioRuntime, ServerTransportProvider } from '@makaio/runtime-node';

// ---------------------------------------------------------------------------
// Mocking
// ---------------------------------------------------------------------------

const shutdownMock = vi.fn<() => Promise<void>>(() => Promise.resolve());
const resolveUpstreamTelemetryMock = vi.fn<() => CoreBootOptions['upstreamTelemetry']>(() => undefined);

const mockBus: IMakaioBus = {} as IMakaioBus;

const bootMock = vi.fn<
  (transport: ServerTransportProvider, port: number, host: string, options: CoreBootOptions) => Promise<MakaioRuntime>
>(() =>
  Promise.resolve({
    bus: mockBus,
    shutdown: shutdownMock,
    port: 0,
    host: '127.0.0.1',
    machineId: 'test-machine-id',
    trayEntries: [],
    windowRegistry: {} as MakaioRuntime['windowRegistry'],
    coordinator: {} as MakaioRuntime['coordinator'],
  }),
);

// The entire @makaio/runtime-node boundary is mocked because a real boot needs
// SQLite/filesystem. resolveUpstreamTelemetryBootOptionsFromEnv is stubbed at the
// same seam so these tests can assert bootEmbeddedWorkflowRuntime's option-forwarding
// contract; the resolver's real env-parsing behavior is covered end-to-end in
// runtimes/node/src/__tests__/upstream-telemetry-config.test.ts.
vi.mock('@makaio/runtime-node', () => ({
  bootMakaioRuntimeCore: bootMock,
  resolveUpstreamTelemetryBootOptionsFromEnv: resolveUpstreamTelemetryMock,
}));

vi.mock('@makaio/kernel/providers', () => ({
  NoTransportProvider: class {
    public async connect(): Promise<void> {}
    public async disconnect(): Promise<void> {}
  },
}));

// ---------------------------------------------------------------------------
// Import subjects under test AFTER mocks are in place
// ---------------------------------------------------------------------------

const { default: workflowCli } = await import('../cli.js');
const { bootEmbeddedWorkflowRuntime } = await import('../embedded-workflow-runtime.js');
const { workflowExtensionConfig, workflowRuntimeExternals } = await import('../../build-config.js');

// ---------------------------------------------------------------------------
// CLI contribution structural invariants
// ---------------------------------------------------------------------------

describe('workflowCli contribution', () => {
  it('declares canProvideBus: true', () => {
    expect(workflowCli.canProvideBus).toBe(true);
  });

  it('declares provideBus as a function', () => {
    expect(typeof workflowCli.provideBus).toBe('function');
  });

  it('declares beforeRun that unconditionally returns { proceed: true }', () => {
    const result = workflowCli.beforeRun?.({
      subcommandName: 'run',
      args: {},
      bus: null,
    });
    expect(result).toEqual({ proceed: true });
  });
});

describe('workflow package public dependencies', () => {
  it('uses runtime-node as a public peer API instead of the removed wrapper seam', () => {
    const packageJsonPath = resolve(import.meta.dirname, '..', '..', 'package.json');
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };

    expect(manifest.dependencies?.['@makaio/runtime-node']).toBeUndefined();
    expect(manifest.peerDependencies?.['@makaio/bus-core']).toBeUndefined();
    expect(manifest.dependencies?.['@makaio/node-workflow-runtime']).toBeUndefined();
    expect(manifest.peerDependencies?.['@makaio/runtime-node']).toBe('^1.0.0');
    expect(manifest.devDependencies?.['@makaio/runtime-node']).toBe('workspace:*');
    expect(manifest.peerDependencies?.['@makaio/framework']).toBeDefined();
  });

  it('externalizes runtime-node from the extension bundle', () => {
    expect(workflowRuntimeExternals[0]).toBe('@makaio/runtime-node');
    expect(workflowRuntimeExternals[1]).toEqual(/^@makaio\/runtime-node\//);
    expect(workflowExtensionConfig.plugins).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// bootEmbeddedWorkflowRuntime — options forwarded to bootMakaioRuntimeCore
// ---------------------------------------------------------------------------

describe('bootEmbeddedWorkflowRuntime', () => {
  beforeEach(() => {
    bootMock.mockClear();
    shutdownMock.mockClear();
    resolveUpstreamTelemetryMock.mockClear();
    resolveUpstreamTelemetryMock.mockReturnValue(undefined);
  });

  it('calls bootMakaioRuntimeCore with surface: headless', async () => {
    await bootEmbeddedWorkflowRuntime({ subcommandName: 'run', args: {}, cwd: '/tmp' });

    expect(bootMock).toHaveBeenCalledTimes(1);
    const options = bootMock.mock.calls[0]?.[3];
    expect(options?.surface).toBe('headless');
  });

  it('calls bootMakaioRuntimeCore with enablePackageManager: false', async () => {
    await bootEmbeddedWorkflowRuntime({ subcommandName: 'run', args: {}, cwd: '/tmp' });

    const options = bootMock.mock.calls[0]?.[3];
    expect(options?.enablePackageManager).toBe(false);
  });

  it('calls bootMakaioRuntimeCore with workflowRunner.mode: in-process', async () => {
    await bootEmbeddedWorkflowRuntime({ subcommandName: 'run', args: {}, cwd: '/tmp' });

    const options = bootMock.mock.calls[0]?.[3];
    expect(options?.workflowRunner).toEqual({ mode: 'in-process' });
  });

  it('resolves push embedded upstream telemetry from environment', async () => {
    await bootEmbeddedWorkflowRuntime({ subcommandName: 'run', args: {}, cwd: '/tmp' });

    expect(resolveUpstreamTelemetryMock).toHaveBeenCalledTimes(1);
  });

  it('passes resolved upstream telemetry options to bootMakaioRuntimeCore', async () => {
    const upstreamTelemetry = {
      transport: {} as NonNullable<CoreBootOptions['upstreamTelemetry']>['transport'],
    };
    resolveUpstreamTelemetryMock.mockReturnValueOnce(upstreamTelemetry);

    await bootEmbeddedWorkflowRuntime({ subcommandName: 'run', args: {}, cwd: '/tmp' });

    const options = bootMock.mock.calls[0]?.[3];
    expect(options?.upstreamTelemetry).toBe(upstreamTelemetry);
  });

  it('returns the bus from the booted runtime', async () => {
    const handle = await bootEmbeddedWorkflowRuntime({ subcommandName: 'run', args: {}, cwd: '/tmp' });

    expect(handle.bus).toBe(mockBus);
  });

  it('dispose calls runtime.shutdown()', async () => {
    const handle = await bootEmbeddedWorkflowRuntime({ subcommandName: 'run', args: {}, cwd: '/tmp' });

    await handle.dispose();

    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('passes boundPort 0 and boundHost 127.0.0.1 to bootMakaioRuntimeCore', async () => {
    await bootEmbeddedWorkflowRuntime({ subcommandName: 'run', args: {}, cwd: '/tmp' });

    const [, boundPort, boundHost] = bootMock.mock.calls[0] as [
      ServerTransportProvider,
      number,
      string,
      CoreBootOptions,
    ];
    expect(boundPort).toBe(0);
    expect(boundHost).toBe('127.0.0.1');
  });

  it('passes a NoTransportProvider instance as the first argument to bootMakaioRuntimeCore', async () => {
    await bootEmbeddedWorkflowRuntime({ subcommandName: 'run', args: {}, cwd: '/tmp' });

    const transport = bootMock.mock.calls[0]?.[0];
    expect(typeof transport?.connect).toBe('function');
    expect(typeof transport?.disconnect).toBe('function');
  });

  it('dispose() is idempotent, calling it twice only invokes shutdown once', async () => {
    const handle = await bootEmbeddedWorkflowRuntime({ subcommandName: 'run', args: {}, cwd: '/tmp' });

    await handle.dispose();
    await handle.dispose();

    expect(shutdownMock).toHaveBeenCalledTimes(1);
  });

  it('dispose() shares an in-flight shutdown across concurrent callers', async () => {
    let resolveShutdown: () => void = () => {
      throw new Error('shutdown promise was not initialized');
    };
    shutdownMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveShutdown = resolve;
        }),
    );
    const handle = await bootEmbeddedWorkflowRuntime({ subcommandName: 'run', args: {}, cwd: '/tmp' });

    const firstDispose = handle.dispose();
    const secondDispose = handle.dispose();
    expect(shutdownMock).toHaveBeenCalledTimes(1);

    resolveShutdown();
    await Promise.all([firstDispose, secondDispose]);
  });

  it('dispose() retries shutdown after a failed attempt', async () => {
    shutdownMock.mockRejectedValueOnce(new Error('shutdown failed')).mockResolvedValueOnce(undefined);
    const handle = await bootEmbeddedWorkflowRuntime({ subcommandName: 'run', args: {}, cwd: '/tmp' });

    await expect(handle.dispose()).rejects.toThrow('shutdown failed');
    await handle.dispose();

    expect(shutdownMock).toHaveBeenCalledTimes(2);
  });
});
