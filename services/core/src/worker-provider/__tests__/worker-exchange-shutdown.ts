import type { IHostMakaioBus } from '@makaio/bus-core';
import type { OrderedWorkerProvider } from '@makaio/contracts/extension';
import {
  createShutdownSequence,
  ExtensionCoordinator,
  type BoundedShutdownStep,
  type KernelExtensionContext,
} from '@makaio/kernel';
import { createJournalCapability, JournalContributionProcessor, SubjectDirectory } from '../../journal/index.js';
import { bindWorkerDispatch } from '../../../../../runtimes/node/src/worker-dispatch-host-binding.js';
import { JournalStartBarrier } from '../../../../../runtimes/node/src/journal-start-barrier.js';
import { resourceStep } from '../../../../../runtimes/node/src/runtime-stop-budget.js';
import type { WorkerRedemptionHost } from '../redeem-worker.js';

/**
 * Compose the production dispatch drain, provider lifecycle and database close.
 * @param bus - Running host bus.
 * @param host - Persisted owner and proof fixture.
 * @param provider - Managed provider with a private worker launch channel.
 * @param close - Real test database close.
 * @returns Host exchange, registered shutdown stages and idempotent stop.
 */
export async function bindExchangeShutdown(
  bus: IHostMakaioBus,
  host: WorkerRedemptionHost,
  provider: OrderedWorkerProvider,
  close: () => Promise<void>,
) {
  const steps: BoundedShutdownStep[] = [];
  const startGate = new JournalStartBarrier();
  const dispatch = bindWorkerDispatch(host, host.database, steps, close);
  if (dispatch === undefined) throw new Error('Missing worker dispatch');
  const coordinator: ExtensionCoordinator<KernelExtensionContext> = new ExtensionCoordinator(bus, {
    extensionContextBase: {
      platform: process.platform,
      homedir: '/tmp',
      makaioHome: '/tmp',
      username: 'test',
      machineId: 'test',
      tryImport: async () => null,
      constructContext(context) {
        return {
          ...context,
          database: host.database,
          journal: createJournalCapability({
            extension: context.identity.extensionName,
            bus: context.bus,
            host: host.database,
            subjects,
            contributions,
            isActive: () => context.hasExtension(context.identity.extensionName),
            startGate,
          }),
        };
      },
    },
  });
  const subjects = new SubjectDirectory(bus, coordinator);
  const contributions = new JournalContributionProcessor(subjects);
  coordinator.registerContributionProcessor(dispatch.contributionProcessor);
  coordinator.load([
    {
      name: 'example',
      version: '1.0.0',
      displayName: 'Test worker provider',
      critical: true,
      workerProviders: {
        createProviders: () => ({ key: 'primary', managedScopeConfirmed: true, providers: [provider] }),
      },
      create: async () => ({}),
    },
  ]);
  await coordinator.startAll();
  startGate.open();
  let sequence: ReturnType<typeof createShutdownSequence> | undefined;
  return {
    ...dispatch,
    steps,
    run() {
      // Transport first, then the dispatch drain and storage, then the fixture registration.
      sequence ??= createShutdownSequence(
        [resourceStep('extensions', () => coordinator.shutdown()), ...steps].reverse(),
      );
      return sequence.run();
    },
  };
}
