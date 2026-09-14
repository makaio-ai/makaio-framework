import { randomUUID } from 'node:crypto';
import { createBusInstance } from '@makaio/bus-core';
import { FrameworkContractNamespaces, FrameworkStorageNamespaces } from '@makaio/contracts';
import {
  runWorkloadInvocation,
  type InstalledWorkloadAdapter,
  type WorkloadInvocationPreparation,
  type WorkloadInvocationResult,
} from './workload-invocation.js';
import { registerWorkerRuntime } from './runtime-registration-client.js';
import { bootstrapWorkerRuntime, type BootstrapRuntimeConnection } from './bootstrap-start-client.js';
import { withWorkerBootstrapDeadline } from './worker-bootstrap-exchange.js';
import { installAttemptControlEndpoint, type InstalledAttemptControlEndpoint } from './attempt-control-client.js';
import type {
  HeadlessWorkerBootstrap,
  HeadlessWorkerBootstrapCredentials,
  HeadlessWorkerBusConnector,
} from './headless-workflow-worker.js';
import type { OutcomeSubmitRetryConfig } from './outcome-submission.js';

/** Fixed host shutdown budget for draining independently retried control reports. */
const CONTROL_REPORT_DRAIN_DEADLINE_MS = 5_000;

// ─────────────────────────────────────────────────────────────
// Dependency types
// ─────────────────────────────────────────────────────────────

/**
 * Injected dependencies for the generic headless worker harness.
 *
 * Unlike {@link HeadlessWorkflowWorkerDeps}, this type is workload-agnostic:
 * the caller supplies pre-built {@link InstalledWorkloadAdapter} instances
 * instead of workflow-specific `execute`, `materialize`, and
 * `loadContributions` callbacks.
 */
export interface HeadlessWorkerDeps {
  /** Unique execution identifier. */
  readonly executionId: string;
  /** Authority-created attempt identifier. */
  readonly executionAttemptId: string;
  /** Immutable absolute deadline created with the Attempt, shared by every bootstrap phase. */
  readonly bootstrapDeadlineAt: string;
  /** Explicit host-delivered environment; never inferred from ambient process state. */
  readonly workflowEnv: Readonly<Record<string, string>>;
  /** Private setup-process environment, supplied separately from workflowEnv and never persisted. */
  readonly setupEnv?: Readonly<NodeJS.ProcessEnv>;
  /** Claim execution-scoped bus credentials. */
  readonly bootstrap: HeadlessWorkerBootstrap;
  /** Establish the authenticated bus connection. */
  readonly connectBus: HeadlessWorkerBusConnector;
  /** Explicit project Workspace path; required only by an instruction requesting one. */
  readonly workspaceRoot?: string;
  /** Optional local Workspace Preparation installed by the hosting provider. */
  readonly preparation?: WorkloadInvocationPreparation;
  /** Pre-built workload adapters available in this Runtime. */
  readonly adapters: readonly InstalledWorkloadAdapter[];
  /**
   * Optional retry configuration for outcome submission.
   *
   * Controls exponential back-off parameters, overall deadline, and
   * maximum retry count. When omitted, sane defaults apply (7 retries,
   * 1 s base delay, 30 s cap, 2 min deadline).
   */
  readonly outcomeRetry?: OutcomeSubmitRetryConfig;
}

/**
 * Terminal result of a generic headless worker execution.
 *
 * This is an alias for the already-generic {@link WorkloadInvocationResult},
 * preserving technical failure, cancellation and opaque workload results
 * together with the Authority's durable acknowledgement.
 */
export type HeadlessWorkerResult = WorkloadInvocationResult;

/**
 * Register one Runtime, then run optional Workspace Preparation and Invocation
 * for any workload kind.
 *
 * The authenticated control bus stays connected through the canonical outcome
 * acknowledgement. Workload-specific code acquisition and runtime composition
 * happen only inside the installed adapter's admitted Invocation.
 *
 * This is the workload-agnostic counterpart of
 * {@link runHeadlessWorkflowWorker}: callers supply pre-built adapters instead
 * of workflow-specific callbacks. The workflow runner is refactored to build
 * its adapter and delegate here.
 * @param deps - Provider and installed workload adapter dependencies.
 * @param signal - Cancellation signal from the process or caller.
 * @returns Canonical outcome and durable acknowledgement.
 */
export async function runHeadlessWorker(deps: HeadlessWorkerDeps, signal: AbortSignal): Promise<HeadlessWorkerResult> {
  signal.throwIfAborted();
  const runtimeIncarnationId = randomUUID();
  const credentials = await withWorkerBootstrapDeadline(deps.bootstrapDeadlineAt, signal, (bootstrapSignal) =>
    deps.bootstrap(bootstrapSignal),
  );
  const { connection, endpoint } = await bootstrapWorkerRuntime({
    executionAttemptId: deps.executionAttemptId,
    runtimeIncarnationId,
    bootstrapDeadlineAt: deps.bootstrapDeadlineAt,
    signal,
    createConnection: () => createHeadlessConnection(deps, credentials),
  });
  const preBus = connection.bus;
  const controlReportDrain = new AbortController();
  let result: HeadlessWorkerResult | undefined;
  let control: InstalledAttemptControlEndpoint | undefined;
  try {
    control = await installAttemptControlEndpoint(
      preBus,
      { executionAttemptId: deps.executionAttemptId, runtimeIncarnationId },
      {
        reportOptions: {
          retry: deps.outcomeRetry,
          reconnect: () => preBus.reconnect(),
        },
        reportSignal: controlReportDrain.signal,
        signal,
      },
    );
    const runtimeGeneration = await registerWorkerRuntime(preBus, {
      executionAttemptId: deps.executionAttemptId,
      runtimeIncarnationId,
      signal,
    });
    endpoint.bindGeneration(runtimeGeneration);
    control.bindGeneration(runtimeGeneration);
    result = await runWorkloadInvocation(preBus, {
      executionAttemptId: deps.executionAttemptId,
      runtimeGeneration,
      workspaceRoot: deps.workspaceRoot,
      setupEnv: deps.setupEnv,
      preparation: deps.preparation,
      adapters: deps.adapters,
      signal: AbortSignal.any([signal, control.signal]),
      control: control.observer,
      retry: deps.outcomeRetry,
      reconnect: () => preBus.reconnect(),
    });
    return result;
  } finally {
    try {
      // Order matters: `finished()` may be the transition that makes the
      // conclusion derivable, so it runs before anything is torn down.
      // `cleanup()` then removes the subscription, so no further delivery is
      // answered, and only then is the drain awaited — draining before cleanup
      // would let a delivery arriving mid-drain dispatch a report the drain
      // has already stopped waiting for.
      control?.observer.finished();
      control?.cleanup();
      // A receipt remains durable even if shutdown cannot wait for its report.
      // The host gets a fixed private drain window; its expiry aborts report
      // requests and retries before the bus is closed, without claiming that
      // either the report or the workload stop succeeded.
      let controlReportDrainClose: Promise<void> | undefined;
      const controlReportDrainTimer = setTimeout(() => {
        controlReportDrain.abort();
        controlReportDrainClose = Promise.resolve(connection.close());
        // The await below reports a close failure through the normal cleanup
        // path, while this handler prevents an early unhandled rejection.
        void controlReportDrainClose.catch(() => {});
      }, CONTROL_REPORT_DRAIN_DEADLINE_MS);
      try {
        await control?.settle();
      } finally {
        clearTimeout(controlReportDrainTimer);
      }
      endpoint.cleanup();
      await (controlReportDrainClose ?? connection.close());
    } catch {
      // Best-effort cleanup; the result (if any) is already determined.
    }
  }
}

/**
 * Acquire cleanup ownership before a provider starts asynchronous connection work.
 * @param deps - Provider connector and workload dependencies.
 * @param credentials - Attempt-scoped credentials, without private environment data.
 * @returns A fresh connection whose late failure cannot retain a transport.
 */
function createHeadlessConnection(
  deps: HeadlessWorkerDeps,
  credentials: HeadlessWorkerBootstrapCredentials,
): BootstrapRuntimeConnection {
  const bus = createBusInstance();
  bus.registerNamespaces([...FrameworkContractNamespaces, ...FrameworkStorageNamespaces]);
  return {
    bus,
    async connect(signal) {
      try {
        await deps.connectBus(bus, credentials, signal);
        signal.throwIfAborted();
      } catch (error) {
        bus.disconnect();
        throw error;
      }
    },
    close: () => bus.disconnect(),
  };
}
