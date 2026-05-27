/**
 * Embedded Makaio runtime for standalone workflow execution.
 *
 * Boots a headless Makaio runtime in-process. All bus traffic flows through
 * the in-process `MakaioBus` singleton, and the workflow engine uses its
 * in-process DAG scheduler so `makaio workflow run` works without a separately
 * running Makaio daemon.
 */
import { NoTransportProvider } from '@makaio/kernel/providers';
import type { EmbeddedBusHandle, ProvideBusContext } from '@makaio/kernel/cli';
import { bootMakaioRuntimeCore, type ServerTransportProvider } from '@makaio/runtime-node';

/**
 * Boot a headless Makaio runtime for standalone workflow execution.
 *
 * Called by the CLI router when `makaio workflow <subcommand>` is dispatched
 * and the contribution declares `canProvideBus: true`. The runtime uses a
 * {@link NoTransportProvider} and configures the workflow engine in
 * in-process mode so executions run within the CLI process.
 * @param _context - Subcommand invocation context; standalone workflow boot currently uses static policy.
 * @returns A handle containing the live bus instance and runtime shutdown hook.
 */
export async function bootEmbeddedWorkflowRuntime(_context: ProvideBusContext): Promise<EmbeddedBusHandle> {
  const transport: ServerTransportProvider = new NoTransportProvider();

  const runtime = await bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
    surface: 'headless',
    enablePackageManager: false,
    workflowRunner: { mode: 'in-process' },
  });

  let shutdownPromise: Promise<void> | undefined;
  return {
    bus: runtime.bus,
    dispose: async () => {
      shutdownPromise ??= runtime.shutdown().catch((error: unknown) => {
        shutdownPromise = undefined;
        throw error;
      });
      await shutdownPromise;
    },
  };
}
