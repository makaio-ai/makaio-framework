import { writeSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBusInstance, localSubject, NoHandlerError, type BusMessage, type IMakaioBus } from '@makaio/bus-core';
import { busContextOf, ownerOf } from '@makaio/bus-core/kernel-api';
import { createBusNamespace } from '@makaio/core';
import {
  ExtensionCoordinator,
  runBoundedShutdownSteps,
  type BoundedShutdownStep,
  type KernelMakaioExtension,
} from '@makaio/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { bootMakaioRuntimeCore } from './boot.js';
import { ExplicitDescriptorDiscovery } from './extension-discovery.js';
import { installHostShutdown } from './host-shutdown.js';
import {
  bootCancellationBudgetMs,
  bootCheckpointGraceMs,
  extensionsStep,
  resourceStep,
  resourceStepStopBudgetMs,
} from './runtime-stop-budget.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  writeSync: vi.fn(),
}));

describe('the windows a runtime boot and its teardown run in', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('keeps the extensions step, the credential channel and the transport intact when an extension uses its whole window', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const closed: string[] = [];
    const windowMs = 80;
    const usesAll: KernelMakaioExtension = {
      name: 'uses-all',
      displayName: 'uses-all',
      version: '0.1.0',
      create: () => ({
        stopBudgetMs: windowMs,
        // Armed after the step's own timer: it takes exactly the declared window.
        destroy: () => new Promise<void>((resolve) => setTimeout(resolve, windowMs)),
      }),
    };
    const coordinator = new ExtensionCoordinator(createBusInstance(), {
      extensionContextBase: {
        platform: 'linux',
        homedir: '/home/test',
        makaioHome: '/home/test/.makaio',
        username: 'test',
        machineId: 'machine-1',
        tryImport: async () => null,
      },
    });
    coordinator.load([usesAll]);
    await coordinator.startAll();

    // The order a boot registers them in, run in reverse.
    const failures = await runBoundedShutdownSteps([
      extensionsStep(coordinator),
      resourceStep('credentials channel', () => void closed.push('credentials')),
      resourceStep('bus transport', () => void closed.push('transport')),
    ]);

    expect(failures).toEqual([]);
    expect(closed).toEqual(['credentials', 'transport']);
    expect(coordinator.list().find((info) => info.name === 'uses-all')?.state).toBe('stopped');
  });

  it.each([
    'resolves',
    'rejects',
  ] as const)('keeps extension requests local until transport disconnect %s and then releases the claim', async (disconnectOutcome) => {
    const name = 'shutdown-routing';
    const subject = `${name}.inspect`;
    const inspect = { request: z.object({}), response: z.object({}) };
    const namespace = createBusNamespace(name, { inspect: localSubject(inspect) }, { defaultTransports: 'local-only' });
    const catalog = createBusNamespace(name, { inspect });
    const sent: string[] = [];
    const makaioHome = await mkdtemp(join(tmpdir(), 'makaio-shutdown-routing-'));
    vi.stubEnv('MAKAIO_DATABASE_URL', undefined);
    vi.stubEnv('MAKAIO_DATABASE_PATH', join(makaioHome, 'runtime.sqlite'));
    vi.stubEnv('MAKAIO_SKIP_EXTENSIONS', undefined);
    let unregister = (): void => {};
    let beforeDisconnect = async (): Promise<void> => {};
    const transport = {
      name,
      connect: async () => {},
      disconnect: async () => {},
      onReceive: () => () => {},
      subscribe: async () => {},
      unsubscribe: async () => {},
      /**
       * Limit the test peer to the request whose routing is under test.
       * @param message - Candidate outbound message.
       */
      canSend(message: BusMessage): boolean {
        return message.type === 'request' && message.namespace === name && message.subject === 'inspect';
      },
      /**
       * Record a remote dispatch and decline the request.
       * @param message - Message dispatched by the bus.
       */
      async send(message: BusMessage): Promise<never> {
        if (message.type === 'request') sent.push(`${message.namespace}.${message.subject}`);
        throw new NoHandlerError(subject);
      },
    };
    const provider = {
      /**
       * Register the peer and advertise its handler for the test request.
       * @param bus - The runtime's bus.
       */
      async connect(bus: IMakaioBus): Promise<void> {
        bus.registerTransport(transport);
        unregister = () => bus.unregisterTransport(name);
        busContextOf(bus).remoteRequestHandlers.set(subject, [{ transport: name, priority: 0 }]);
      },
      async disconnect(): Promise<void> {
        try {
          await beforeDisconnect();
        } finally {
          unregister();
        }
      },
    };

    try {
      const runtime = await bootMakaioRuntimeCore(provider, 0, '127.0.0.1', {
        makaioHome,
        frameworkVersion: '3.0.0',
        hostCapabilities: ['node'],
        discovery: new ExplicitDescriptorDiscovery([
          {
            descriptor: {
              name,
              displayName: name,
              version: '1.0.0',
              makaio: { framework: '>=1.0.0' },
              entrypoints: { server: true },
            },
            extensionPath: makaioHome,
            source: 'local',
            preloadedModule: { default: { name, displayName: name, version: '1.0.0', namespaces: [namespace] } },
          },
        ]),
      });
      const disconnectError = new Error('transport disconnect failed');
      beforeDisconnect = async () => {
        expect(runtime.coordinator.getInfo(name)?.state).toBe('stopped');
        // ORIGIN: The test probes routing on the runtime bus just before the peer disconnects.
        const call = runtime.bus.own('root');
        // A catalog token relies on the live registry for its routing policy.
        await expect(runtime.bus.requestOptional(call, catalog.subjects.inspect, {})).resolves.toEqual({
          handled: false,
        });
        expect(sent).toEqual([]);
        expect(busContextOf(runtime.bus).namespaceRegistry.isLocalSubject(subject)).toBe(true);
        if (disconnectOutcome === 'rejects') throw disconnectError;
      };
      if (disconnectOutcome === 'rejects') {
        await expect(runtime.shutdown()).rejects.toMatchObject({ errors: [disconnectError] });
      } else {
        await runtime.shutdown();
      }
      expect(ownerOf(runtime.bus, name)).toBeUndefined();
    } finally {
      await rm(makaioHome, { recursive: true, force: true });
    }
  });

  describe('a host that waits for a cancelled boot', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
      vi.spyOn(console, 'info').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      process.exitCode = undefined;
    });

    it('keeps waiting while the rollback of a resource the phase in flight registered is within its windows', async () => {
      const rollbackSteps: BoundedShutdownStep[] = [];
      const grace = bootCheckpointGraceMs();
      const closeMs = resourceStepStopBudgetMs() - 1_000;
      const closed: string[] = [];

      // A boot whose database open takes most of the grace, then registers the close of it and
      // reaches the checkpoint: the rollback needs a window that was not there when the host
      // armed its timer.
      const boot = (async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, grace - 1_000));
        rollbackSteps.push(
          resourceStep('database', () =>
            new Promise<void>((resolve) => setTimeout(resolve, closeMs)).then(() => void closed.push('database')),
          ),
        );
        await runBoundedShutdownSteps([...rollbackSteps].reverse());
      })();

      const hostShutdown = installHostShutdown({
        label: 'test',
        signals: [],
        steps: [
          { name: 'runtime boot', budgetMs: () => bootCancellationBudgetMs(rollbackSteps) + 1_000, run: () => boot },
        ],
      });

      const finished = hostShutdown.request('SIGTERM');
      await vi.advanceTimersByTimeAsync(grace - 1_000 + closeMs + 10);
      await finished;

      expect(closed).toEqual(['database']);
      expect(process.exit).not.toHaveBeenCalled();
      expect(writeSync).not.toHaveBeenCalled();
    });

    it('still ends the host when the phase in flight never registers anything and never finishes', async () => {
      const hostShutdown = installHostShutdown({
        label: 'test',
        signals: [],
        steps: [
          {
            name: 'runtime boot',
            budgetMs: () => bootCancellationBudgetMs([]),
            run: () => new Promise<void>(() => undefined),
          },
        ],
      });

      const finished = hostShutdown.request('SIGTERM');
      await vi.advanceTimersByTimeAsync(bootCheckpointGraceMs() + 10);
      await finished;

      expect(process.exit).toHaveBeenCalledWith(1);
    });
  });
});
