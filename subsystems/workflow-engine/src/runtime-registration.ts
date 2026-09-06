import type { IMakaioBus } from '@makaio/bus-core';
import {
  ExecutionAttemptSchemas,
  ExecutionAttemptSubjects,
  type ExecutionAttemptRuntimeRegisterRefusalReason,
  type ExecutionAttemptRuntimeRegisterResponse,
} from '@makaio/contracts';
import { resolveExecutionAttemptPeer } from './execution-bound-access.js';
import type { ExecutionAttemptAuthority } from './execution-attempt-authority.js';

// ─────────────────────────────────────────────────────────────
// Probe Delivery Budget
// ─────────────────────────────────────────────────────────────

/**
 * Time the authority waits for the runtime's receipt of the bounded probe.
 *
 * Strictly below the bus-wide `DEFAULT_REQUEST_TIMEOUT_MS` of 60 000 ms the
 * outer `execution-attempt.runtime.register` request runs on, so a dead
 * endpoint fails its own registration with `probe-failed` instead of timing
 * out the runtime that is waiting for the decision.
 */
export const RUNTIME_PROBE_DELIVERY_TIMEOUT_MS = 10_000;

/**
 * Generation reported alongside every `refused` registration decision.
 *
 * A refusal hands out no fence. The wire response types a refusal's
 * `runtimeGeneration` as the literal zero, and only a refusal may carry it:
 * every `ready` or `duplicate` generation the repository allocates is positive,
 * so a runtime can never mistake a refusal for a registration at generation
 * zero.
 */
const NO_RUNTIME_GENERATION = 0;

// ─────────────────────────────────────────────────────────────
// Runtime Registration Dependencies
// ─────────────────────────────────────────────────────────────

/**
 * Dependencies for the runtime registration handler.
 */
export interface RuntimeRegistrationDeps<TOutcome> {
  /**
   * Bus the authority speaks on.
   *
   * Carries the probe delivery request and the readiness event. The bus the
   * handler is registered on is the registrar's own first argument; in every
   * production wiring the two are the same instance.
   */
  readonly bus: IMakaioBus;
  /** Execution attempt Authority service. */
  readonly authority: ExecutionAttemptAuthority<TOutcome>;
  /**
   * Probe delivery budget override, in milliseconds.
   *
   * Defaults to {@link RUNTIME_PROBE_DELIVERY_TIMEOUT_MS}. Exists so a test can
   * pin the timeout branch without waiting ten seconds for it; production
   * wiring omits it.
   */
  readonly probeDeliveryTimeoutMs?: number;
}

// ─────────────────────────────────────────────────────────────
// Handler Registration
// ─────────────────────────────────────────────────────────────

/**
 * Register the `execution-attempt.runtime.register` bus handler.
 *
 * The single authority gate for runtime registration. It runs the whole
 * handshake inside the one request the runtime made, so the reply is the
 * runtime's complete answer and there is no `not-ready` retry loop:
 *
 * 1. Resolve the authenticated attempt peer and refuse unless its attempt id
 *    equals the payload's. Local origin is not a bypass — this handler is the
 *    identity fence, and the peer is where `executionId` comes from, because no
 *    payload in the namespace carries one.
 * 2. `registerRuntime`. A `duplicate` that already proved readiness announces
 *    that readiness again (step 7) and is answered `duplicate`; a `duplicate` without
 *    readiness is a replay of this incarnation's own report and continues at
 *    step 3 exactly as `registered` does. Every other refusal is reported
 *    one-to-one.
 * 3. Admit the bounded runtime probe under `probe:<runtimeIncarnationId>`. **No
 *    `operation.admitted` event is published for `runtime-probe`** — the probe
 *    never reaches the pool.
 * 4. Deliver the probe to the runtime's own filtered subscription within
 *    {@link RUNTIME_PROBE_DELIVERY_TIMEOUT_MS}. The delivery names the
 *    incarnation, so only the endpoint that registered can answer it. A
 *    `refused` receipt, a timeout, an absent responder, or any throw fails the
 *    registration with `probe-failed`, releases the probe's slot, and leaves
 *    readiness unproven.
 * 5. `completeOperation`, which frees the attempt for real work.
 * 6. `markRuntimeReady`, which makes readiness durable for this generation and
 *    is the last fence: an attempt superseded since step 2 is refused here.
 * 7. Publish `execution-attempt.runtime.ready` for the durable readiness, on
 *    the `ready` transition and on every `duplicate` that finds it already
 *    persisted. Announcements are at-least-once projections of durable state:
 *    the authority re-reads the control state right before it announces and
 *    publishes only the readiness that still holds — the same generation, still
 *    ready — so a newer incarnation that registered in between is never
 *    misrepresented by a stale announcement; a retried registration announces
 *    again, so an announcement whose first pass failed after persistence is
 *    delivered by the next pass; and every consumer is idempotent and
 *    generation-aware — the worker pool projects each generation once and
 *    ignores older ones, the Fly tracker resolves once, and observability
 *    upserts. What this does not cover is a process that exits between
 *    persisting readiness and announcing it: until a durable publication marker
 *    exists, that readiness is announced by the next registration of the same
 *    incarnation, or never.
 * 8. Reply `ready` with the generation the runtime must fence everything else
 *    with.
 *
 * Step 7 is unreachable unless step 5 persisted the completion: readiness is
 * announced only after the probe receipt became a durable fact.
 * @param bus - Bus the handler subscribes on.
 * @param deps - Runtime registration dependencies.
 * @returns Cleanup function for handler deregistration.
 */
export function registerRuntimeRegistrationHandler<TOutcome>(
  bus: IMakaioBus,
  deps: RuntimeRegistrationDeps<TOutcome>,
): () => void {
  const probeTimeout = deps.probeDeliveryTimeoutMs ?? RUNTIME_PROBE_DELIVERY_TIMEOUT_MS;

  return bus.on(ExecutionAttemptSubjects.runtime.register, async (ctx) => {
    // Step 1: identity fence.
    const peer = resolveExecutionAttemptPeer(ctx);
    if (peer === null) {
      throw new Error('Runtime registration requires an authenticated workflow-execution-attempt peer');
    }
    // The bus validates a request where it is sent, not where it is received,
    // and skips even that in production. A report that reaches this gate is
    // therefore parsed here, before anything about it becomes durable.
    const { executionAttemptId, runtimeIncarnationId } = ExecutionAttemptSchemas['runtime.register'].request.parse(
      ctx.payload,
    );
    if (executionAttemptId !== peer.executionAttemptId) {
      throw new Error(
        `Registration payload executionAttemptId '${executionAttemptId}' does not match ` +
          `authenticated peer identity '${peer.executionAttemptId}'`,
      );
    }

    // Step 2: allocate the generation, or learn why this runtime may not own
    // the endpoint. Refusal precedence is the repository's, reported verbatim.
    const registration = await deps.authority.registerRuntime({
      executionAttemptId,
      executionId: peer.executionId,
      runtimeIncarnationId,
    });
    if (registration.kind === 'duplicate' && registration.runtimeReadyAt !== null) {
      // This incarnation already proved itself. Re-delivering the probe would
      // occupy an attempt that is free to run real work; the durable readiness
      // is announced again instead, so a first pass whose announcement failed
      // is repaired by this one.
      await announceReadiness(deps, executionAttemptId, registration.runtimeGeneration);
      ctx.setResult({ decision: 'duplicate', runtimeGeneration: registration.runtimeGeneration });
      return;
    }
    if (registration.kind !== 'registered' && registration.kind !== 'duplicate') {
      ctx.setResult(refused(registration.kind));
      return;
    }
    // A `duplicate` without readiness reaches here. Every runtime mints its
    // incarnation identifier per process, so this branch serves a replay of the
    // same report — a retried request, or a crash between register and ready
    // inside one process — and nothing else: a restarted runtime is a new
    // incarnation, takes a new generation, and re-proves itself from step 2. The
    // recovery unit is the attempt, not the incarnation.
    const runtimeGeneration = registration.runtimeGeneration;

    // Steps 3 to 6: prove the endpoint and make its readiness durable.
    const readiness = await proveRuntimeEndpoint(deps, probeTimeout, {
      executionAttemptId,
      executionId: peer.executionId,
      runtimeIncarnationId,
      runtimeGeneration,
    });
    if (readiness === null) {
      ctx.setResult(refused('probe-failed'));
      return;
    }

    // Step 7: announce the proven endpoint from the durable record, not from
    // what this pass observed. Announced on `ready` and on `duplicate` alike —
    // see the handler doc for the at-least-once rule.
    await announceReadiness(deps, executionAttemptId, runtimeGeneration);

    // Step 8.
    ctx.setResult({ decision: 'ready', runtimeGeneration });
  });
}

/**
 * Announce durable readiness on the bus, if it still holds.
 *
 * At-least-once by design: every pass that finds readiness persisted announces
 * it, and consumers collapse repeats. The announcement is a projection of the
 * durable record, so the record is read again right here: between
 * `markRuntimeReady` and this emit another incarnation may have registered,
 * which advances the generation and clears readiness, and announcing the old
 * generation then would tell the pool a runtime is ready that the attempt no
 * longer has. Nothing is announced unless the stored generation is the one
 * this pass proved and readiness is still recorded for it; the event carries
 * the stored instant.
 *
 * The re-read fences generation and readiness only, not settlement or a
 * terminated allocation: `markRuntimeReady` refuses both, and a read cannot
 * close a read-then-emit window anyway, because either can still win between
 * this read and the emit. The event states that readiness was accepted for
 * this generation at `acceptedAt`, which stays true after the attempt
 * settles; every consumer discards a `ready` that arrives after its terminal
 * projection, and the runtime's next admission is refused. Publication in the
 * same linearization as the transition belongs to the durable publication
 * seam that follows this cut: an outbox row per transition, events carrying
 * an event id and the authority version.
 * @param deps - Runtime registration dependencies.
 * @param executionAttemptId - Attempt whose runtime is ready.
 * @param runtimeGeneration - Generation the readiness belongs to.
 */
async function announceReadiness<TOutcome>(
  deps: RuntimeRegistrationDeps<TOutcome>,
  executionAttemptId: string,
  runtimeGeneration: number,
): Promise<void> {
  const control = await deps.authority.getAttemptControlState(executionAttemptId);
  if (control === null || control.runtimeGeneration !== runtimeGeneration || control.runtimeReadyAt === null) {
    return;
  }
  await deps.bus.emit(ExecutionAttemptSubjects.runtime.ready, {
    executionAttemptId,
    runtimeGeneration,
    acceptedAt: control.runtimeReadyAt,
  });
}

/** Readiness the handshake made durable, and whether this pass made it so. */
type ProvenReadiness = { readonly kind: 'ready' | 'duplicate'; readonly acceptedAt: string };

/**
 * Prove that a registered runtime endpoint accepts a fenced instruction.
 *
 * Steps 3 to 6 of the handshake, as one all-or-nothing move: admit the bounded
 * probe, deliver it, persist its completion, and record readiness. Every way of
 * failing is the same fact — the endpoint was not proven — so they share one
 * answer, and the caller turns it into `probe-failed`.
 *
 * A failure after admission releases the probe's slot before answering. The
 * probe is the authority's own operation; leaving it active would refuse every
 * later incarnation with `operation-active` for an endpoint nobody proved.
 *
 * Nothing is announced from here: the probe is never projected to the pool, and
 * readiness is announced by the caller only once this returned a `ready`.
 * @param deps - Runtime registration dependencies.
 * @param probeTimeout - Delivery budget in milliseconds.
 * @param attempt - Attempt identity, its owner, the incarnation, and its fence.
 * @returns The durable readiness, or `null` when the endpoint was not proven.
 */
async function proveRuntimeEndpoint<TOutcome>(
  deps: RuntimeRegistrationDeps<TOutcome>,
  probeTimeout: number,
  attempt: {
    readonly executionAttemptId: string;
    readonly executionId: string;
    readonly runtimeIncarnationId: string;
    readonly runtimeGeneration: number;
  },
): Promise<ProvenReadiness | null> {
  const { executionAttemptId, executionId, runtimeIncarnationId, runtimeGeneration } = attempt;

  // Step 3: admit the bounded probe. Nothing is announced for it.
  const admission = await deps.authority.admitOperation({
    executionAttemptId,
    executionId,
    operationKind: 'runtime-probe',
    admissionKey: `probe:${runtimeIncarnationId}`,
    runtimeGeneration,
  });
  if (admission.kind !== 'admitted' && admission.kind !== 'duplicate') return null;
  const operationId = admission.operationId;
  const releaseProbe = (): Promise<void> =>
    releaseAdmittedProbe(deps, { executionAttemptId, operationId, runtimeGeneration });

  // Step 4: the endpoint accepts a fenced instruction. The subject is static;
  // the addressing is the runtime's own subscription filter on attempt and
  // incarnation, so a stale incarnation of the same attempt is a filter miss.
  // A timeout, an absent responder, and a throwing one are the same fact as a
  // refusal.
  let receipt: 'completed' | 'duplicate' | 'refused';
  try {
    const delivered = await deps.bus.request(
      ExecutionAttemptSubjects.operation.deliver,
      { executionAttemptId, runtimeIncarnationId, operationId, operationKind: 'runtime-probe', runtimeGeneration },
      { timeout: probeTimeout },
    );
    receipt = delivered.receipt;
  } catch {
    await releaseProbe();
    return null;
  }
  if (receipt !== 'completed' && receipt !== 'duplicate') {
    await releaseProbe();
    return null;
  }

  // Step 5: persist the completion. Readiness is announced only after this. A
  // refusal here means something else took the slot; the probe's own release
  // is then answered from the last completion or refused as a mismatch, and
  // either way the endpoint stays unproven.
  const completion = await deps.authority.completeOperation({ executionAttemptId, operationId, runtimeGeneration });
  if (completion.kind !== 'completed' && completion.kind !== 'duplicate') return null;

  // Step 6: make readiness durable for this generation, and for an attempt that
  // is still current — the fence a superseding attempt raised since step 2 is
  // applied here, after the slot was already released.
  const readiness = await deps.authority.markRuntimeReady({
    executionAttemptId,
    executionId,
    runtimeGeneration,
    readyAt: new Date().toISOString(),
  });
  if (readiness.kind !== 'ready' && readiness.kind !== 'duplicate') return null;
  return { kind: readiness.kind, acceptedAt: readiness.acceptedAt };
}

/**
 * Release the probe an unproven endpoint left admitted.
 *
 * Best effort: whatever the repository answers, the registration is reported
 * `probe-failed`. A throw here must not mask that reply, so it is swallowed —
 * the slot is then released by the next completion or by settlement.
 * @param deps - Runtime registration dependencies.
 * @param probe - Attempt identity, the probe operation, and its fence.
 */
async function releaseAdmittedProbe<TOutcome>(
  deps: RuntimeRegistrationDeps<TOutcome>,
  probe: { readonly executionAttemptId: string; readonly operationId: string; readonly runtimeGeneration: number },
): Promise<void> {
  try {
    await deps.authority.completeOperation(probe);
  } catch {
    // Reported as `probe-failed` regardless; see the doc comment.
  }
}

/**
 * Build a refused registration decision.
 * @param refusalReason - Why the registration was refused.
 * @returns The wire response carrying the refusal and no fence.
 */
function refused(refusalReason: ExecutionAttemptRuntimeRegisterRefusalReason): ExecutionAttemptRuntimeRegisterResponse {
  return { decision: 'refused', runtimeGeneration: NO_RUNTIME_GENERATION, refusalReason };
}
