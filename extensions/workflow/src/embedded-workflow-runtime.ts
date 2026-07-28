/**
 * Embedded Makaio runtime for standalone workflow execution.
 *
 * Boots a headless Makaio runtime in-process. All control traffic flows
 * through the in-process `MakaioBus` singleton, and the no-transport embedded
 * execution path remains in-process without a separately running daemon.
 */
import { NoTransportProvider } from '@makaio/kernel/providers';
import type { EmbeddedBusHandle, ProvideBusContext } from '@makaio/kernel/cli';
// `resolveUpstreamTelemetryBootOptionsFromEnv` is introduced in the same
// runtime-node release as this consumer, and release tooling tightens the
// runtime-node peer range in package.json to that introducing version at
// publish. The declared `^1.0.0` therefore cannot resolve to a runtime-node
// build that predates this export.
import {
  bootMakaioRuntimeCore,
  resolveUpstreamTelemetryBootOptionsFromEnv,
  type ServerTransportProvider,
} from '@makaio/runtime-node';
import { computeDirectoryDigest } from '@makaio/runtime-node/workflow-worker';
import type { WorkflowMaterializationSpecResolver } from '@makaio/subsystem-workflow-engine';
import { isAbsolute, relative, resolve } from 'node:path';

/** Stable portable workspace identity for one embedded CLI invocation. */
const CLI_WORKSPACE_ID = 'cli-invocation-workspace';

/**
 * Build the CLI's explicit local workspace seams from its invocation context.
 *
 * The CLI owns one known directory: the command's absolute working directory.
 * It never infers additional roots from workflow paths. This makes a
 * path-backed invocation portable while retaining local-directory's strict
 * allowed-root semantics.
 * @param cwd - Absolute command working directory.
 * @returns Resolver for durable local-directory specs.
 */
function createCliWorkspaceResolvers(cwd: string): {
  readonly materializationSpecResolver: WorkflowMaterializationSpecResolver;
} {
  const workspaceRoot = resolve(cwd);
  return {
    materializationSpecResolver: {
      async resolve(input) {
        const sourcePath = relative(workspaceRoot, input.sourcePath);
        if (
          sourcePath.length === 0 ||
          sourcePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
          isAbsolute(sourcePath)
        ) {
          throw new Error(`CLI workflow source must be contained in the invocation workspace: ${input.sourcePath}`);
        }
        return {
          kind: 'local-directory',
          workspaceId: CLI_WORKSPACE_ID,
          rootDigest: await computeDirectoryDigest(workspaceRoot),
          sourcePath,
        };
      },
    },
  };
}

/**
 * Boot a headless Makaio runtime for standalone workflow execution.
 *
 * Called by the CLI router when `makaio workflow <subcommand>` is dispatched
 * and the contribution declares `canProvideBus: true`. The runtime uses a
 * {@link NoTransportProvider} and configures the workflow engine in
 * in-process mode, with the invocation CWD as its only allowed workspace.
 * @param context - Subcommand invocation context that owns the allowed workspace.
 * @returns A handle containing the live bus instance and runtime shutdown hook.
 */
export async function bootEmbeddedWorkflowRuntime(context: ProvideBusContext): Promise<EmbeddedBusHandle> {
  const transport: ServerTransportProvider = new NoTransportProvider();
  const upstreamTelemetry = resolveUpstreamTelemetryBootOptionsFromEnv();
  const { materializationSpecResolver } = createCliWorkspaceResolvers(context.cwd);

  const runtime = await bootMakaioRuntimeCore(transport, 0, '127.0.0.1', {
    surface: 'headless',
    enablePackageManager: false,
    workflowRunner: { mode: 'in-process' },
    workflowMaterializationSpecResolvers: [materializationSpecResolver],
    ...(upstreamTelemetry === undefined ? {} : { upstreamTelemetry }),
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
