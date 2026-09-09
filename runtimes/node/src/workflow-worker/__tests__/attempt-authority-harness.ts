import type { IMakaioBus } from '@makaio/bus-core';
import { HmacAuth } from '@makaio/bus-transport-websocket';
import type {
  ExecutionAttemptOperationAdmittedEvent,
  ExecutionAttemptRuntimeReadyEvent,
  ExecutionAttemptInstruction,
  ExecutionAttemptOutcome,
  WorkflowRunContext,
  WorkspaceRequirement,
} from '@makaio/contracts';
import { ExecutionAttemptSubjects, WorkflowWorkerConfigSchema } from '@makaio/contracts';
import {
  ExecutionAttemptAuthority,
  buildWorkflowAttemptInstruction,
  decodeWorkflowAttemptOutcome,
  registerExecutionAttemptHandlers,
  registerBootstrapStartHandler,
  registerOperationAdmissionHandler,
  registerRuntimeRegistrationHandler,
  workflowAttemptOutcomeCodec,
  type WorkflowAttemptOutcome,
} from '@makaio/subsystem-workflow-engine';
import {
  driveTestAttemptToAllocated,
  makeTestInstruction,
  createInMemoryAttemptRepository,
} from '@makaio/subsystem-workflow-engine/testing';

// ─────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────

/** Authority-side ExecutionAttempt gates one integration host runs against. */
export interface AttemptAuthorityHarness {
  /** Authority the gates are bound to, over the in-memory attempt repository. */
  readonly authority: ExecutionAttemptAuthority<WorkflowAttemptOutcome>;
  /** Owner effects observed after the real Authority has committed its canonical outcome. */
  readonly convergedOutcomes: WorkflowAttemptOutcome[];
  /** Execution the attempt belongs to. */
  readonly executionId: string;
  /** The allocated attempt a worker may register against. */
  readonly executionAttemptId: string;
  /** Durable creation-time budget shared by every bootstrap connection. */
  readonly bootstrapDeadlineAt: string;
  /** Every `execution-attempt.runtime.ready` the Authority published, in order. */
  readonly runtimeReadyEvents: ExecutionAttemptRuntimeReadyEvent[];
  /** Every `execution-attempt.operation.admitted` the Authority published, in order. */
  readonly operationAdmittedEvents: ExecutionAttemptOperationAdmittedEvent[];
  /** Server-side auth that resolves this attempt's authenticated peer. */
  readonly serverAuth: HmacAuth;
  /**
   * Build the client-side auth a worker connection authenticates with.
   *
   * One per socket: the pre-composition bus and the runtime bus each connect
   * with their own transport, and both claim the same attempt identity.
   * @returns Client auth claiming {@link executionAttemptId}.
   */
  readonly createClientAuth: () => HmacAuth;
  /** Unbind the Authority gates and event captures. */
  readonly cleanup: () => Promise<void>;
}

/** Shared secret for the attempt peer of a harness-backed integration host. */
const ATTEMPT_TRANSPORT_SECRET = 'attempt-authority-harness-secret';

/** Frozen assignment and narrow failure-injection hooks for the real ingress path. */
export interface AttemptAuthorityHarnessOptions {
  readonly instruction: ExecutionAttemptInstruction;
  readonly beforeCommit?: (outcome: WorkflowAttemptOutcome, report: ExecutionAttemptOutcome) => Promise<void>;
  readonly beforeConverge?: () => Promise<void>;
}

/**
 * Freeze a fixture through the production workflow-owner builder, never a latest-context lookup.
 * @param runContext - Owner-selected portable workflow context.
 * @param workspace - Optional, separately declared project working area.
 * @returns Detached instruction for creation of an Attempt.
 */
export function freezeWorkflowInstruction(
  runContext: WorkflowRunContext,
  workspace?: WorkspaceRequirement,
): ExecutionAttemptInstruction {
  return buildWorkflowAttemptInstruction({
    id: `instruction-${runContext.executionId}`,
    revision: '1',
    config: WorkflowWorkerConfigSchema.parse({ ...runContext, definition: runContext.definitionSnapshot }),
    runContext,
    ...(workspace === undefined ? {} : { workspace }),
    preservation: { required: [] },
  });
}

/**
 * Stand the Authority-side ExecutionAttempt gates up on an integration host.
 *
 * The gates take their caller's identity from the authenticated transport
 * peer, so a host that lets a worker register owes three things at once: an
 * Authority over a real attempt repository, an attempt driven to `allocated`,
 * and a transport that authenticates that attempt. This builds all three, and
 * captures what the gates publish so a test can assert on readiness and
 * admission without subscribing to the namespace itself.
 *
 * No namespace is registered here — `execution-attempt` is static and every
 * host already carries it through `FrameworkContractNamespaces`.
 *
 * The caller wires {@link AttemptAuthorityHarness.serverAuth} into its bus
 * server transport and {@link AttemptAuthorityHarness.createClientAuth} into
 * every worker-side WebSocket transport.
 * @param bus - Authority bus the gates are bound on and publish to.
 * @param executionId - Execution the attempt belongs to.
 * @param options - Explicit frozen instruction; omitted by legacy runner-only fixtures.
 * @returns The harness handle the integration host drives.
 */
export async function createAttemptAuthorityHarness(
  bus: IMakaioBus,
  executionId: string,
  options?: AttemptAuthorityHarnessOptions,
): Promise<AttemptAuthorityHarness> {
  const repository = createInMemoryAttemptRepository(workflowAttemptOutcomeCodec);
  const authority = new ExecutionAttemptAuthority(repository, { bootstrapTimeoutMs: 120_000 });
  const { executionAttemptId, bootstrapDeadlineAt } = await authority.createAttempt(
    executionId,
    options?.instruction ?? makeTestInstruction(),
  );
  if (bootstrapDeadlineAt === null) throw new Error('New fixture Attempt must have a bootstrap deadline');
  // The fixture owns the runner waiter too; refusal tests deliberately reject it.
  void authority.waitForOutcome(executionAttemptId)?.catch(() => undefined);
  await driveTestAttemptToAllocated(authority, executionAttemptId, executionId);
  const convergedOutcomes: WorkflowAttemptOutcome[] = [];
  const offIngress =
    options === undefined
      ? () => {}
      : registerExecutionAttemptHandlers(bus, {
          authority,
          decodeOutcome: async (input) => {
            const outcome = decodeWorkflowAttemptOutcome(input);
            await options.beforeCommit?.(outcome, input.outcome);
            return outcome;
          },
          convergence: {
            async converge({ executionAttemptId: attemptId, outcome }) {
              if (!repository.committedOutcomes.has(attemptId))
                throw new Error('Convergence ran before durable commitment');
              await options.beforeConverge?.();
              convergedOutcomes.push(outcome);
              return 'projected';
            },
          },
        });

  const runtimeReadyEvents: ExecutionAttemptRuntimeReadyEvent[] = [];
  const operationAdmittedEvents: ExecutionAttemptOperationAdmittedEvent[] = [];

  const offRuntimeReady = bus.on(ExecutionAttemptSubjects.runtime.ready, (ctx) => {
    runtimeReadyEvents.push({ ...ctx.payload });
  });
  const offOperationAdmitted = bus.on(ExecutionAttemptSubjects.operation.admitted, (ctx) => {
    operationAdmittedEvents.push({ ...ctx.payload });
  });
  const offRegister = registerRuntimeRegistrationHandler(bus, { bus, authority });
  const offBootstrap = registerBootstrapStartHandler(bus, authority);
  const offAdmit = registerOperationAdmissionHandler(bus, { bus, authority });

  const serverAuth = new HmacAuth({
    secret: ATTEMPT_TRANSPORT_SECRET,
    resolveSecret: (claimedId) => (claimedId === executionAttemptId ? ATTEMPT_TRANSPORT_SECRET : null),
    resolvePeer: (claimedId) =>
      claimedId === executionAttemptId
        ? { kind: 'workflow-execution-attempt', id: claimedId, authenticated: true, claims: { executionId } }
        : null,
  });

  return {
    authority,
    convergedOutcomes,
    executionId,
    executionAttemptId,
    bootstrapDeadlineAt,
    runtimeReadyEvents,
    operationAdmittedEvents,
    serverAuth,
    createClientAuth: () => new HmacAuth({ secret: ATTEMPT_TRANSPORT_SECRET, identityId: executionAttemptId }),
    cleanup: async () => {
      offIngress();
      offRegister();
      offBootstrap();
      offAdmit();
      offRuntimeReady();
      offOperationAdmitted();
    },
  };
}
