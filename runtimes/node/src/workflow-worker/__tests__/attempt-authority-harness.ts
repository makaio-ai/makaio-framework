import type { IMakaioBus } from '@makaio/bus-core';
import { HmacAuth } from '@makaio/bus-transport-websocket';
import type {
  ExecutionAttemptOperationAdmittedEvent,
  ExecutionAttemptRuntimeReadyEvent,
  WorkflowRunResult,
} from '@makaio/contracts';
import { ExecutionAttemptSubjects } from '@makaio/contracts';
import {
  ExecutionAttemptAuthority,
  registerOperationAdmissionHandler,
  registerRuntimeRegistrationHandler,
} from '@makaio/subsystem-workflow-engine';
import {
  allocateTestAttempt,
  createInMemoryAttemptRepository,
  workflowRunResultOutcomeCodec,
} from '@makaio/subsystem-workflow-engine/testing';

// ─────────────────────────────────────────────────────────────
// Harness
// ─────────────────────────────────────────────────────────────

/** Authority-side ExecutionAttempt gates one integration host runs against. */
export interface AttemptAuthorityHarness {
  /** Authority the gates are bound to, over the in-memory attempt repository. */
  readonly authority: ExecutionAttemptAuthority<WorkflowRunResult>;
  /** Execution the attempt belongs to. */
  readonly executionId: string;
  /** The allocated attempt a worker may register against. */
  readonly executionAttemptId: string;
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
  /** Unbind both gates and both captures. */
  readonly cleanup: () => Promise<void>;
}

/** Shared secret for the attempt peer of a harness-backed integration host. */
const ATTEMPT_TRANSPORT_SECRET = 'attempt-authority-harness-secret';

/**
 * Stand the Authority-side ExecutionAttempt gates up on an integration host.
 *
 * Both gates take their caller's identity from the authenticated transport
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
 * @returns The harness handle the integration host drives.
 */
export async function createAttemptAuthorityHarness(
  bus: IMakaioBus,
  executionId: string,
): Promise<AttemptAuthorityHarness> {
  const authority = new ExecutionAttemptAuthority(createInMemoryAttemptRepository(workflowRunResultOutcomeCodec));
  const executionAttemptId = await allocateTestAttempt(authority, executionId);

  const runtimeReadyEvents: ExecutionAttemptRuntimeReadyEvent[] = [];
  const operationAdmittedEvents: ExecutionAttemptOperationAdmittedEvent[] = [];

  const offRuntimeReady = bus.on(ExecutionAttemptSubjects.runtime.ready, (ctx) => {
    runtimeReadyEvents.push({ ...ctx.payload });
  });
  const offOperationAdmitted = bus.on(ExecutionAttemptSubjects.operation.admitted, (ctx) => {
    operationAdmittedEvents.push({ ...ctx.payload });
  });
  const offRegister = registerRuntimeRegistrationHandler(bus, { bus, authority });
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
    executionId,
    executionAttemptId,
    runtimeReadyEvents,
    operationAdmittedEvents,
    serverAuth,
    createClientAuth: () => new HmacAuth({ secret: ATTEMPT_TRANSPORT_SECRET, identityId: executionAttemptId }),
    cleanup: async () => {
      offRegister();
      offAdmit();
      offRuntimeReady();
      offOperationAdmitted();
    },
  };
}
