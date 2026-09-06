import { waitForSubscriptionPropagation, type IMakaioBus } from '@makaio/bus-core';
import type { z } from 'zod';
import {
  ExecutionAttemptSchemas,
  ExecutionAttemptSubjects,
  type ExecutionAttemptOperationAdmitRefusalReason,
  type ExecutionAttemptOperationDelivery,
  type ExecutionAttemptOperationKind,
  type ExecutionAttemptOperationReceipt,
  type ExecutionAttemptRuntimeRegisterRefusalReason,
} from '@makaio/contracts';

// ─────────────────────────────────────────────────────────────
// Operation delivery endpoint
// ─────────────────────────────────────────────────────────────

/**
 * Operation kinds a runtime endpoint may be handed by the authority.
 *
 * `runtime-probe` is excluded: the bounded probe is the authority's own proof
 * that the endpoint accepts a fenced instruction, and
 * {@link installOperationDeliveryEndpoint} answers it itself. A caller-supplied
 * probe handler would be a second way to answer the same delivery.
 */
export type DeliverableOperationKind = Exclude<ExecutionAttemptOperationKind, 'runtime-probe'>;

/**
 * Runtime-side executor for one delivered operation.
 *
 * Receives the delivery verbatim and returns the receipt the authority sees.
 * A handler that cannot honour the delivery returns a `refused` receipt with
 * its reason rather than throwing — a throw is reported to the authority as a
 * failed request, which it reads as an unproven endpoint.
 * @param delivery - The operation the authority handed to this runtime.
 * @returns The receipt reported back to the authority.
 */
export type OperationDeliveryHandler = (
  delivery: ExecutionAttemptOperationDelivery,
) => ExecutionAttemptOperationReceipt | Promise<ExecutionAttemptOperationReceipt>;

/**
 * Handlers a runtime installs for the operation kinds it can execute.
 *
 * Partial by design: a delivery whose kind has no handler is answered
 * `refused` / `unknown-kind`, which is the honest report of a runtime that
 * does not know the instruction.
 */
export type OperationDeliveryHandlers = Partial<Record<DeliverableOperationKind, OperationDeliveryHandler>>;

/** Identity the delivery endpoint is installed for. */
export interface OperationDeliveryEndpointIdentity {
  /** Attempt this runtime owns; the first half of the delivery filter. */
  readonly executionAttemptId: string;
  /** This runtime incarnation; the second half of the delivery filter. */
  readonly runtimeIncarnationId: string;
  /**
   * Generation this incarnation was accepted with, when already known.
   *
   * Set when the endpoint is re-installed on another bus after registration
   * (the pre-composition → runtime bus handoff). A fresh endpoint installed
   * before registration leaves it out and learns the generation through
   * {@link OperationDeliveryEndpoint.bindGeneration}.
   */
  readonly runtimeGeneration?: number;
}

/** The installed delivery endpoint of one runtime incarnation. */
export interface OperationDeliveryEndpoint {
  /**
   * Fence later deliveries against the generation the authority accepted.
   *
   * Called once registration returned. The probe needs no fence — it is
   * addressed to this incarnation and arrives before the generation exists —
   * but every other delivery is refused `stale-generation` unless it carries
   * exactly this generation.
   * @param runtimeGeneration - Generation returned by registration.
   */
  bindGeneration(runtimeGeneration: number): void;
  /** Remove the endpoint from its bus. Idempotent. */
  cleanup(): void;
}

/**
 * Answer one delivery from the installed handler set.
 *
 * The probe is answered here rather than by a handler: it is the authority's
 * proof of the endpoint, not runtime work, and every runtime answers it the
 * same way. Every other kind is fenced against the accepted generation first.
 * @param delivery - The operation the authority handed to this runtime.
 * @param handlers - Handlers the runtime installed.
 * @param acceptedGeneration - Generation this incarnation was accepted with, once known.
 * @returns The receipt reported back to the authority.
 */
async function answerDelivery(
  delivery: ExecutionAttemptOperationDelivery,
  handlers: OperationDeliveryHandlers,
  acceptedGeneration: number | undefined,
): Promise<ExecutionAttemptOperationReceipt> {
  if (delivery.operationKind === 'runtime-probe') {
    return { receipt: 'completed' };
  }
  // An endpoint that does not know its generation yet cannot verify the fence,
  // and a delivery fenced against another generation belongs to a runtime
  // that is gone. Both are the same refusal.
  if (acceptedGeneration === undefined || delivery.runtimeGeneration !== acceptedGeneration) {
    return { receipt: 'refused', refusalReason: 'stale-generation' };
  }
  const handler = handlers[delivery.operationKind];
  if (handler === undefined) {
    return { receipt: 'refused', refusalReason: 'unknown-kind' };
  }
  return await handler(delivery);
}

/**
 * Install this runtime's responder for `execution-attempt.operation.deliver`.
 *
 * The subject is static and every live Worker Runtime subscribes to it, so the
 * addressing is a payload filter on the runtime's own attempt and incarnation
 * (`bus.withFilter({ executionAttemptId, runtimeIncarnationId })`, the same
 * move the adapter session endpoints make in `adapters/core`). A delivery for
 * another attempt — or for a newer incarnation of this attempt while this one
 * is still connected — is a filter miss that returns undefined and
 * auto-advances the dispatch chain to the next responder; it is not an error
 * and this endpoint never sees it.
 *
 * The endpoint must exist before the runtime registers: the authority delivers
 * the bounded probe inside the registration request, and an unsubscribed
 * runtime fails its own registration with `probe-failed`. The returned
 * propagation await is what makes "before" true across a transport — the
 * subscription is visible to the authority when this resolves.
 * @param bus - Connected runtime bus the endpoint is installed on.
 * @param identity - Attempt and incarnation this runtime is; the delivery filter.
 * @param handlers - Handlers for the operation kinds this runtime can execute.
 * @returns The installed endpoint: a generation binder and its cleanup.
 */
export async function installOperationDeliveryEndpoint(
  bus: IMakaioBus,
  identity: OperationDeliveryEndpointIdentity,
  handlers: OperationDeliveryHandlers,
): Promise<OperationDeliveryEndpoint> {
  const { executionAttemptId, runtimeIncarnationId } = identity;
  let acceptedGeneration = identity.runtimeGeneration;
  // Trust boundary: this filter is applied by the bus in this process only.
  // The transport does not receive handler filters with the subscription, and
  // the per-identity subject allowlist admits every attempt credential to the
  // same static delivery subject, so the authority's server sees every live
  // runtime as an unfiltered responder and routes in connection order. A
  // runtime that honours its filter never answers for another attempt; a
  // compromised attempt credential that installs an unfiltered handler could
  // answer another attempt's probe. Enforcing the attempt and incarnation at
  // the authenticated transport boundary is a framework gap, not something a
  // client-side filter can close.
  let off: (() => void) | undefined = bus
    .withFilter({ executionAttemptId, runtimeIncarnationId })
    .on(ExecutionAttemptSubjects.operation.deliver, async (ctx) => {
      ctx.setResult(await answerDelivery(ctx.payload, handlers, acceptedGeneration));
    });
  await waitForSubscriptionPropagation(off);
  return {
    bindGeneration(runtimeGeneration: number): void {
      acceptedGeneration = runtimeGeneration;
    },
    cleanup(): void {
      const cleanup = off;
      off = undefined;
      cleanup?.();
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Refusal errors
// ─────────────────────────────────────────────────────────────

/**
 * Error thrown when the authority refuses a runtime registration.
 *
 * A refusal hands out no generation, so there is nothing for the caller to
 * fence with and no partial success to report: the runtime cannot proceed.
 */
export class RuntimeRegistrationRefusedError extends Error {
  /**
   * @param executionAttemptId - Attempt whose registration was refused.
   * @param refusalReason - Authority's reason, absent only if it reported none.
   */
  public constructor(
    public readonly executionAttemptId: string,
    public readonly refusalReason: ExecutionAttemptRuntimeRegisterRefusalReason | undefined,
  ) {
    super(
      `Runtime registration refused by the Authority ` +
        `(executionAttemptId=${executionAttemptId}, refusalReason=${refusalReason ?? 'unreported'})`,
    );
    this.name = 'RuntimeRegistrationRefusedError';
  }
}

/**
 * Error thrown when the authority refuses an operation admission.
 *
 * A refused admission means the operation never passed the attempt's start
 * gate, so the caller must not run it.
 */
export class OperationAdmissionRefusedError extends Error {
  /**
   * @param executionAttemptId - Attempt the admission was requested against.
   * @param admissionKey - Idempotency key the caller admitted under.
   * @param refusalReason - Authority's reason, absent only if it reported none.
   */
  public constructor(
    public readonly executionAttemptId: string,
    public readonly admissionKey: string,
    public readonly refusalReason: ExecutionAttemptOperationAdmitRefusalReason | undefined,
  ) {
    super(
      `Operation admission refused by the Authority ` +
        `(executionAttemptId=${executionAttemptId}, admissionKey=${admissionKey}, ` +
        `refusalReason=${refusalReason ?? 'unreported'})`,
    );
    this.name = 'OperationAdmissionRefusedError';
  }
}

// ─────────────────────────────────────────────────────────────
// Registration and admission
// ─────────────────────────────────────────────────────────────

/**
 * Parse a gate response against its canonical schema before acting on it.
 *
 * The bus validates a response where it is received only outside production,
 * so a version-skewed or independently implemented authority can answer with
 * a shape the contract does not know, and treating any non-refusal as success
 * would start work no gate admitted. The same move the gates make with their
 * requests: parse first, decide after.
 * @param subject - Subject the response answers, named in the error message.
 * @param schema - Canonical response schema of that subject.
 * @param payload - What the authority answered.
 * @param executionAttemptId - Attempt the request was made for.
 * @returns The response, typed by the contract.
 * @throws When the response does not match the contract.
 */
function parseGateResponse<TSchema extends z.ZodType>(
  subject: { readonly subject: string; readonly $meta: { readonly namespace: string } },
  schema: TSchema,
  payload: unknown,
  executionAttemptId: string,
): z.infer<TSchema> {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`);
  throw new Error(
    `Malformed '${subject.$meta.namespace}.${subject.subject}' response from the Authority ` +
      `(executionAttemptId=${executionAttemptId}): ${issues.join('; ')}`,
  );
}

/**
 * How long a registration keeps retrying a `not-allocated` refusal.
 *
 * The allocation-visibility window: a provider that runs its runtime in
 * process starts it inside `provision()`, and the pool records the returned
 * allocation only afterwards. Until that record is durable the authority
 * answers `not-allocated`, which is a fact about timing, not about this
 * runtime. Same value and same reasoning as `BOOTSTRAP_CONNECT_TIMEOUT_MS` in
 * the container entrypoint's bootstrap claim, which retries the equivalent
 * `attempt-pending` rejection. The window exists because no provider has an
 * activation step the pool drives after the record is durable; until such a
 * barrier exists, the retry is the runtime's only way to wait for the record.
 */
export const ALLOCATION_VISIBILITY_DEADLINE_MS = 10_000;

/** Pause between two registration attempts inside the allocation-visibility window. */
const ALLOCATION_VISIBILITY_RETRY_INTERVAL_MS = 50;

/** Parameters for registering this runtime incarnation with the authority. */
export interface RegisterWorkerRuntimeOptions {
  /** Authority-created attempt identifier this runtime claims. */
  readonly executionAttemptId: string;
  /** Identifier of this concrete runtime incarnation, unique per boot. */
  readonly runtimeIncarnationId: string;
  /** Cancellation signal for the registration request. */
  readonly signal?: AbortSignal;
  /**
   * How long to keep retrying a `not-allocated` refusal, in milliseconds.
   *
   * Defaults to {@link ALLOCATION_VISIBILITY_DEADLINE_MS}. Exists so a test can
   * pin the deadline without waiting ten seconds for it.
   */
  readonly allocationVisibilityDeadlineMs?: number;
}

/**
 * Register this runtime incarnation as the endpoint of its ExecutionAttempt.
 *
 * One request that returns only after the authority made readiness durable:
 * it allocates the generation, admits and delivers the bounded probe to the
 * endpoint installed by {@link installOperationDeliveryEndpoint}, persists the
 * completion, and publishes `execution-attempt.runtime.ready`. The reply is
 * the complete answer; the only refusal retried here is `not-allocated`, and
 * only inside the allocation-visibility window described at
 * {@link ALLOCATION_VISIBILITY_DEADLINE_MS}.
 *
 * A `duplicate` decision is readiness: the authority answers it only for an
 * incarnation that already holds a readiness instant, and it carries the same
 * generation that incarnation was registered with.
 * @param bus - Connected runtime bus authenticated as the attempt peer.
 * @param options - Attempt identity, incarnation identity, cancellation.
 * @returns The generation this runtime must fence all later traffic with.
 * @throws {@link RuntimeRegistrationRefusedError} When the authority refuses.
 */
export async function registerWorkerRuntime(bus: IMakaioBus, options: RegisterWorkerRuntimeOptions): Promise<number> {
  const { executionAttemptId, runtimeIncarnationId, signal } = options;
  const deadline = Date.now() + (options.allocationVisibilityDeadlineMs ?? ALLOCATION_VISIBILITY_DEADLINE_MS);
  for (;;) {
    signal?.throwIfAborted();
    const response = parseGateResponse(
      ExecutionAttemptSubjects.runtime.register,
      ExecutionAttemptSchemas['runtime.register'].response,
      await bus.request(
        ExecutionAttemptSubjects.runtime.register,
        { executionAttemptId, runtimeIncarnationId },
        { signal },
      ),
      executionAttemptId,
    );
    if (response.decision !== 'refused') return response.runtimeGeneration;
    if (response.refusalReason !== 'not-allocated' || Date.now() >= deadline) {
      throw new RuntimeRegistrationRefusedError(executionAttemptId, response.refusalReason);
    }
    await waitForRetry(ALLOCATION_VISIBILITY_RETRY_INTERVAL_MS, signal);
  }
}

/**
 * Wait one retry interval, or less when the signal aborts first.
 * @param intervalMs - Interval to wait.
 * @param signal - Cancellation signal that ends the wait early.
 * @throws When the signal aborts.
 */
function waitForRetry(intervalMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('Registration retry aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, intervalMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Parameters for admitting this runtime's workflow run through the start gate. */
export interface AdmitWorkflowRunOperationOptions {
  /** Authority-created attempt identifier the operation runs under. */
  readonly executionAttemptId: string;
  /** Generation this runtime was registered with. */
  readonly runtimeGeneration: number;
  /** Caller-chosen idempotency key for this admission. */
  readonly admissionKey: string;
  /** Cancellation signal for the admission request. */
  readonly signal?: AbortSignal;
}

/**
 * Admit this runtime's workflow run through the attempt's start gate.
 *
 * The legacy run passes the gate as one admitted operation: materialize, load,
 * compose, execute, and the outcome all stay inside it, and the outcome commit
 * settles the attempt rather than a separate completion call.
 *
 * A `duplicate` decision is the retry of an admission whose first pass already
 * succeeded, so it yields the existing operation identifier.
 * @param bus - Connected runtime bus authenticated as the attempt peer.
 * @param options - Attempt identity, fence, idempotency key, cancellation.
 * @returns The identifier of the admitted operation.
 * @throws {@link OperationAdmissionRefusedError} When the authority refuses.
 * @throws When the authority admits without naming an operation.
 */
export async function admitWorkflowRunOperation(
  bus: IMakaioBus,
  options: AdmitWorkflowRunOperationOptions,
): Promise<string> {
  const { executionAttemptId, runtimeGeneration, admissionKey, signal } = options;
  const response = parseGateResponse(
    ExecutionAttemptSubjects.operation.admit,
    ExecutionAttemptSchemas['operation.admit'].response,
    await bus.request(
      ExecutionAttemptSubjects.operation.admit,
      { executionAttemptId, operationKind: 'workflow-run', admissionKey, runtimeGeneration },
      { signal },
    ),
    executionAttemptId,
  );
  if (response.decision === 'refused') {
    throw new OperationAdmissionRefusedError(executionAttemptId, admissionKey, response.refusalReason);
  }
  if (response.operationId === undefined) {
    throw new Error(
      `Operation admission decision '${response.decision}' named no operation ` +
        `(executionAttemptId=${executionAttemptId}, admissionKey=${admissionKey})`,
    );
  }
  return response.operationId;
}

// ─────────────────────────────────────────────────────────────
// Register-and-admit
// ─────────────────────────────────────────────────────────────

/** Parameters for proving this runtime and admitting its workflow run. */
export interface RegisterAndAdmitWorkflowRunOptions {
  /** Authority-created attempt identifier this runtime claims. */
  readonly executionAttemptId: string;
  /** Identifier of this concrete runtime incarnation, unique per boot. */
  readonly runtimeIncarnationId: string;
  /** The delivery endpoint installed for this incarnation, bound to the accepted generation here. */
  readonly endpoint: OperationDeliveryEndpoint;
  /** Cancellation signal for both requests. */
  readonly signal?: AbortSignal;
}

/** What a runtime holds once its workflow run passed the start gate. */
export interface AdmittedWorkflowRun {
  /** Generation this runtime was accepted with. */
  readonly runtimeGeneration: number;
  /** Identifier of the admitted workflow-run operation. */
  readonly operationId: string;
}

/**
 * Prove this runtime to the authority and admit its workflow run, in order.
 *
 * The one sequence every workflow runtime performs before it pulls work:
 * register (the probe arrives at `options.endpoint` meanwhile), bind the
 * accepted generation onto that endpoint, then admit the run under the
 * incarnation's own key `workflow-run:<runtimeIncarnationId>`, so a retried
 * admission is answered `duplicate` with the same operation.
 * @param bus - Connected runtime bus authenticated as the attempt peer.
 * @param options - Attempt identity, incarnation identity, endpoint, cancellation.
 * @returns The accepted generation and the admitted operation.
 * @throws {@link RuntimeRegistrationRefusedError} When the authority refuses the runtime.
 * @throws {@link OperationAdmissionRefusedError} When the authority refuses the run.
 */
export async function registerAndAdmitWorkflowRun(
  bus: IMakaioBus,
  options: RegisterAndAdmitWorkflowRunOptions,
): Promise<AdmittedWorkflowRun> {
  const { executionAttemptId, runtimeIncarnationId, endpoint, signal } = options;
  const runtimeGeneration = await registerWorkerRuntime(bus, { executionAttemptId, runtimeIncarnationId, signal });
  endpoint.bindGeneration(runtimeGeneration);
  const operationId = await admitWorkflowRunOperation(bus, {
    executionAttemptId,
    runtimeGeneration,
    admissionKey: `workflow-run:${runtimeIncarnationId}`,
    signal,
  });
  return { runtimeGeneration, operationId };
}
