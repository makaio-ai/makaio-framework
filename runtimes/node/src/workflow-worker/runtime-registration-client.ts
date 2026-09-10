import { waitForSubscriptionPropagation, type IFilteredBus, type IMakaioBus } from '@makaio/bus-core';
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
// Fenced attempt endpoint scaffold
// ─────────────────────────────────────────────────────────────

/** Identity a fenced attempt endpoint filters and fences its deliveries with. */
export interface FencedAttemptEndpointIdentity {
  /** Attempt this runtime owns; the first half of the delivery filter. */
  readonly executionAttemptId: string;
  /** This runtime incarnation; the second half of the delivery filter. */
  readonly runtimeIncarnationId: string;
  /**
   * Generation this incarnation was accepted with, when already known.
   *
   * A fresh endpoint installed before registration leaves it out and learns
   * the generation through {@link FencedAttemptEndpoint.bindGeneration}.
   */
  readonly runtimeGeneration?: number;
}

/** What a fenced endpoint's own handler subscribes and fences with. */
export interface FencedAttemptEndpointHost {
  /** Bus filtered to this attempt and incarnation; every subscription inherits the filter. */
  readonly bus: IFilteredBus;
  /**
   * Generation this endpoint is fenced against, or undefined while unbound.
   *
   * A handler that must not refuse an unbound delivery reads this first and
   * only waits through {@link awaitGeneration} when it is undefined, so the
   * bound case stays synchronous.
   */
  readonly acceptedGeneration: number | undefined;
  /**
   * Whether a delivered generation fails this endpoint's fence.
   *
   * An endpoint that does not know its generation yet cannot verify the fence,
   * and a delivery fenced against another generation belongs to a runtime that
   * is gone. Both are stale.
   * @param deliveredGeneration - Generation the authority fenced the delivery with.
   * @returns True when this endpoint must refuse the delivery as stale.
   */
  readonly isStaleGeneration: (deliveredGeneration: number) => boolean;
  /**
   * Wait until this endpoint knows the generation it fences with.
   *
   * The authority can allocate and target a generation while the registration
   * RPC that hands it to this runtime is still in flight. A handler that would
   * otherwise refuse that delivery as stale can defer its answer until the
   * bind instead. Resolves immediately once a generation is bound, and
   * resolves `undefined` when {@link FencedAttemptEndpoint.cleanup} ran
   * first — there will be no bind then, so the handler answers rather than
   * hanging. Never rejects.
   * @returns The bound generation, or undefined when the endpoint was cleaned up unbound.
   */
  readonly awaitGeneration: () => Promise<number | undefined>;
}

/** The generation one fenced endpoint knows, plus the deliveries waiting for it. */
interface GenerationLatch {
  /** Generation currently bound, or undefined while unbound. */
  readonly accepted: () => number | undefined;
  /** The endpoint's fence over a delivered generation. */
  readonly isStale: (deliveredGeneration: number) => boolean;
  /** Wait for the bind; resolves undefined once released without one. */
  readonly wait: () => Promise<number | undefined>;
  /** Bind the accepted generation and release every waiter. */
  readonly bind: (runtimeGeneration: number) => void;
  /** Release every waiter with whatever is bound, and stop waiting for a bind. */
  readonly release: () => void;
}

/**
 * Hold the generation an endpoint fences with and hand it to late deliveries.
 *
 * Waiters are created per call and only while unbound, so nothing is left
 * pending when no delivery raced the bind, and no promise is created that
 * could reject unobserved.
 * @param initial - Generation already known at installation, when there is one.
 * @returns The latch the host and the endpoint share.
 */
function createGenerationLatch(initial: number | undefined): GenerationLatch {
  let accepted = initial;
  let released = false;
  const waiters = new Set<(generation: number | undefined) => void>();
  const wake = (): void => {
    const woken = [...waiters];
    waiters.clear();
    for (const resolve of woken) resolve(accepted);
  };
  return {
    accepted: () => accepted,
    isStale: (deliveredGeneration) => accepted === undefined || deliveredGeneration !== accepted,
    wait: async () => {
      if (accepted !== undefined || released) return accepted;
      return await new Promise<number | undefined>((resolve) => waiters.add(resolve));
    },
    bind: (runtimeGeneration) => {
      accepted = runtimeGeneration;
      wake();
    },
    release: () => {
      released = true;
      wake();
    },
  };
}

/** The installed, generation-fenced endpoint of one runtime incarnation. */
export interface FencedAttemptEndpoint {
  /**
   * Fence later deliveries against the generation the authority accepted, and
   * release any delivery that deferred its answer until this generation existed.
   * @param runtimeGeneration - Generation returned by registration.
   */
  bindGeneration(runtimeGeneration: number): void;
  /** Remove the endpoint from its bus. Idempotent. */
  cleanup(): void;
}

/**
 * Install one attempt- and incarnation-filtered endpoint with a generation fence.
 *
 * Every runtime-side endpoint on a static `execution-attempt` subject needs the
 * same scaffold: a payload filter on the runtime's own attempt and incarnation,
 * a generation the endpoint learns after registration, a subscription that is
 * visible to the authority before the installer resolves, and one cleanup path
 * that also runs on installation abort or failure. This owns exactly that, and
 * leaves answering a delivery to the caller's handler.
 *
 * Trust boundary: the filter is applied by the bus in this process only. The
 * transport does not receive handler filters with the subscription, and the
 * per-identity subject allowlist admits every attempt credential to the same
 * static subjects, so the authority's server sees every live runtime as an
 * unfiltered responder and routes in connection order. A runtime that honours
 * its filter never answers for another attempt; a compromised attempt
 * credential that installs an unfiltered handler could answer another attempt's
 * probe, and on the control subject it could abort another attempt's workload
 * rather than only answering its probe. Enforcing the attempt and incarnation
 * at the authenticated transport boundary is a framework gap, not something a
 * client-side filter can close (TODO FACT-153).
 * @param bus - Connected runtime bus the endpoint is installed on.
 * @param identity - Attempt and incarnation this runtime is; the delivery filter.
 * @param subscribe - Installs the caller's handler on the filtered bus; returns its unsubscribe.
 * @param signal - Optional cancellation while the endpoint becomes visible.
 * @returns The installed endpoint: a generation binder and its cleanup.
 */
export async function installFencedAttemptEndpoint(
  bus: IMakaioBus,
  identity: FencedAttemptEndpointIdentity,
  subscribe: (host: FencedAttemptEndpointHost) => () => void,
  signal?: AbortSignal,
): Promise<FencedAttemptEndpoint> {
  signal?.throwIfAborted();
  const { executionAttemptId, runtimeIncarnationId } = identity;
  const generation = createGenerationLatch(identity.runtimeGeneration);
  let off: (() => void) | undefined = subscribe({
    bus: bus.withFilter({ executionAttemptId, runtimeIncarnationId }),
    get acceptedGeneration(): number | undefined {
      return generation.accepted();
    },
    isStaleGeneration: generation.isStale,
    awaitGeneration: generation.wait,
  });
  const endpoint: FencedAttemptEndpoint = {
    bindGeneration(runtimeGeneration: number): void {
      generation.bind(runtimeGeneration);
    },
    cleanup(): void {
      const cleanup = off;
      off = undefined;
      cleanup?.();
      // A handler deferring for the bind must still answer its delivery: after
      // cleanup no bind is coming, so release it with whatever is known.
      generation.release();
    },
  };
  const onAbort = (): void => endpoint.cleanup();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await waitForSubscriptionPropagation(off);
    signal?.throwIfAborted();
    return endpoint;
  } catch (error) {
    endpoint.cleanup();
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

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

/**
 * Identity the delivery endpoint is installed for.
 *
 * `runtimeGeneration` is set when the endpoint is re-installed on another bus
 * after registration (the pre-composition → runtime bus handoff).
 */
export type OperationDeliveryEndpointIdentity = FencedAttemptEndpointIdentity;

/**
 * The installed delivery endpoint of one runtime incarnation.
 *
 * The probe needs no fence — it is addressed to this incarnation and arrives
 * before the generation exists — but every other delivery is refused
 * `stale-generation` unless it carries exactly the bound generation.
 */
export type OperationDeliveryEndpoint = FencedAttemptEndpoint;

/**
 * Answer one delivery from the installed handler set.
 *
 * The probe is answered here rather than by a handler: it is the authority's
 * proof of the endpoint, not runtime work, and every runtime answers it the
 * same way. Every other kind is fenced against the accepted generation first.
 * @param delivery - The operation the authority handed to this runtime.
 * @param handlers - Handlers the runtime installed.
 * @param isStaleGeneration - The endpoint's generation fence.
 * @returns The receipt reported back to the authority.
 */
async function answerDelivery(
  delivery: ExecutionAttemptOperationDelivery,
  handlers: OperationDeliveryHandlers,
  isStaleGeneration: FencedAttemptEndpointHost['isStaleGeneration'],
): Promise<ExecutionAttemptOperationReceipt> {
  if (delivery.operationKind === 'runtime-probe') {
    return { receipt: 'completed' };
  }
  if (isStaleGeneration(delivery.runtimeGeneration)) {
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
 * addressing is the attempt and incarnation payload filter
 * {@link installFencedAttemptEndpoint} applies (the same move the adapter
 * session endpoints make in `adapters/core`). A delivery for another attempt —
 * or for a newer incarnation of this attempt while this one is still connected
 * — is a filter miss that returns undefined and auto-advances the dispatch
 * chain to the next responder; it is not an error and this endpoint never sees it.
 *
 * The endpoint must exist before the runtime registers: the authority delivers
 * the bounded probe inside the registration request, and an unsubscribed
 * runtime fails its own registration with `probe-failed`. The scaffold's
 * propagation await is what makes "before" true across a transport — the
 * subscription is visible to the authority when this resolves.
 * @param bus - Connected runtime bus the endpoint is installed on.
 * @param identity - Attempt and incarnation this runtime is; the delivery filter.
 * @param handlers - Handlers for the operation kinds this runtime can execute.
 * @param signal - Optional cancellation while the endpoint becomes visible.
 * @returns The installed endpoint: a generation binder and its cleanup.
 */
export async function installOperationDeliveryEndpoint(
  bus: IMakaioBus,
  identity: OperationDeliveryEndpointIdentity,
  handlers: OperationDeliveryHandlers,
  signal?: AbortSignal,
): Promise<OperationDeliveryEndpoint> {
  return await installFencedAttemptEndpoint(
    bus,
    identity,
    (host) =>
      // Unlike the control endpoint, an operation delivery is refused as soon as
      // the fence cannot be verified: the probe needs no generation, and every
      // other operation is the authority handing out work it can hand out again.
      host.bus.on(ExecutionAttemptSubjects.operation.deliver, async (ctx) => {
        ctx.setResult(await answerDelivery(ctx.payload, handlers, host.isStaleGeneration));
      }),
    signal,
  );
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

/** Parameters for registering this runtime incarnation with the authority. */
export interface RegisterWorkerRuntimeOptions {
  /** Authority-created attempt identifier this runtime claims. */
  readonly executionAttemptId: string;
  /** Identifier of this concrete runtime incarnation, unique per boot. */
  readonly runtimeIncarnationId: string;
  /** Cancellation signal for the registration request. */
  readonly signal?: AbortSignal;
}

/**
 * Register this runtime incarnation as the endpoint of its ExecutionAttempt.
 *
 * One request that returns only after the authority made readiness durable:
 * it allocates the generation, admits and delivers the bounded probe to the
 * endpoint installed by {@link installOperationDeliveryEndpoint}, persists the
 * completion, and publishes `execution-attempt.runtime.ready`. The reply is
 * the complete answer. Allocation visibility is awaited by the separate
 * bootstrap start barrier; registration itself never retries a refusal.
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
  if (response.decision === 'refused') {
    throw new RuntimeRegistrationRefusedError(executionAttemptId, response.refusalReason);
  }
  return response.runtimeGeneration;
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
