/**
 * Provider-session ownership for the starts the adapter itself owns.
 *
 * `adapter.startAgent` has many producers and only one of them reserves. Asking
 * each to reserve would put ownership knowledge into every caller — including
 * product callers — and would still leave the next producer unprotected, so the
 * gate lives where every producer must pass: the shared start handler. The
 * adapter reserves exactly when it owns the agent row, which is when the caller
 * supplied no `agentId`; a caller that supplies one has already reserved for the
 * row it minted.
 *
 * Only a `mode: 'resume'` start has a key to reserve. `create` and `fork` starts
 * mint their provider identity inside the provider and have nothing to name at
 * dispatch time, and `ephemeral` starts touch neither session nor agent storage.
 */
import type { IMakaioBus } from '@makaio/bus-core';
import type { ProviderKeyPublication } from './adapter-provider-key-publication.js';
import type { ExtractSubjectResponse } from '@makaio/core';
import type { StartAgentRequestPayload } from './types.js';
import {
  AdapterSubjects,
  SessionSubjects,
  type AdapterSessionClaimDisposition,
  type SessionOwnershipReserveStartServiceResult,
} from '@makaio/contracts';
import { AgentStorageSubjects, reserveStartFor } from '@makaio/services-core/session';
import {
  callerOwnsAgentRow,
  writePreDispatchAgentRow,
  type PersistEmitDeps,
  type ResolvedStartPayload,
} from './ai-adapter-start-persistence.js';

/** The `adapter.startAgent` response, as its handler answers it. */
export type StartAgentResponsePayload = ExtractSubjectResponse<typeof AdapterSubjects.startAgent>;

/** The refusal half of the startAgent response. */
export type StartAgentRefusal = Extract<StartAgentResponsePayload, { success: false }>;

/**
 * The one generation an adapter-owned start took, as it must give it back.
 *
 * Deliberately not the whole reservation: an adapter-owned start reserves as a
 * member, so it designates nothing and has no designation to restore. The claim
 * token is the entire rollback surface, and naming it is what keeps the release
 * scoped to this attempt's generation instead of fanning out over every claim
 * the agent holds.
 */
export interface AdapterStartReservation {
  /** Agent the reservation was taken for. */
  readonly agentId: string;
  /** The generation this start allocated, and the only one it may release. */
  readonly claimToken: string;
}

/** What the authority answered, as the start handler branches on it. */
export type AdapterStartReservationResult =
  | { readonly kind: 'reserved'; readonly reservation: AdapterStartReservation }
  | { readonly kind: 'refused'; readonly message: string };

/**
 * Registry operations a failed start gives its process-local claims back through.
 *
 * Typed structurally rather than as `ActiveAgentRegistry` so this module stays
 * free of the registry's three type parameters; it uses nothing else from it.
 */
export interface StartAcquisitionRegistry {
  /**
   * Atomically claim a provider session for an in-flight start.
   * @param adapterSessionId - Provider session the start intends to resume
   * @returns Whether the session was free and is now held by this attempt
   */
  claimAdapterSession(adapterSessionId: string): boolean;
  /**
   * Give back a provider-session claim taken by an in-flight start.
   * @param adapterSessionId - Provider session the start claimed
   */
  releaseAdapterSessionClaim(adapterSessionId: string): void;
  /**
   * Give back an agent-identity claim taken by an in-flight start.
   * @param agentId - Identity the start claimed
   */
  releaseAgentIdentityClaim(agentId: string): void;
  /**
   * Close and deregister a live agent without writing its storage status.
   *
   * The reported class is unconstrained here: a give-back has nothing to decide on
   * it, and pinning the shape would couple this structural dependency to the
   * teardown taxonomy for no consumer.
   * @param agentId - Agent to evict
   */
  evictSilently(agentId: string): Promise<unknown>;
}

/**
 * Everything an in-flight adapter-owned start has taken and must give back.
 *
 * Mutable and owned by the attempt, because a resource becomes releasable at the
 * instant it is acquired and the handler has to be able to give back whatever
 * the attempt got to — including from a throw between two acquisitions, which is
 * what I20 exists to make impossible to leak.
 */
export interface StartAcquisitions {
  /** Whether an unsettled agent-identity claim is held. */
  claimedIdentity: boolean;
  /** Provider session claimed process-locally, once the claim is granted. */
  resumeAdapterSessionId: string | undefined;
  /** The durable reservation, once it is committed. */
  reservation: AdapterStartReservation | undefined;
  /**
   * When the pre-dispatch agent row was created, once the write was **issued**.
   *
   * Presence is what says the row exists, and the value is what keeps it saying
   * the same thing after the post-dispatch whole-record write replaces it: that
   * second write must not restamp `createdAt` with the moment the connector came
   * up, or the row claims the agent was created after the work it did.
   *
   * Set at the write's *issue*, not at its return, for the reason
   * {@link StartAcquisitions.dispatched} is: a transaction that commits and
   * whose response is then lost leaves a row this attempt would otherwise never
   * settle, and a `starting` row nobody intends to finish is arbitrated over by
   * every later send. Over-reporting reach costs a delete or a compare-and-swap
   * that finds nothing; under-reporting it costs a phantom recovery.
   */
  agentRowCreatedAt: number | undefined;
  /**
   * Whether the provider-touching call was **entered**.
   *
   * Set at its entry rather than at its return: the dispatch activates the
   * provider context, creates the agent and initializes it inside one `try`, and
   * initialization has already spoken to the provider by the time it can fail.
   * Classifying by "did the call return" would delete the row of a live
   * connector and free its ownership key.
   */
  dispatched: boolean;
  /**
   * Whether this start's provider key is still the caller's to publish first.
   *
   * The one gate every publication route consults — see
   * {@link ProviderKeyPublication}. It lives in this bag because its lifetime is
   * the attempt's, like everything else here, and it is released where the
   * attempt hands the key over.
   */
  publication: ProviderKeyPublication;
}

/**
 * Extract the provider-native session ID a resume-mode request names.
 * @param payload - Start-agent request payload
 * @returns Provider session to claim and reserve, or `undefined` for other modes
 */
export function getResumeAdapterSessionId(payload: StartAgentRequestPayload): string | undefined {
  if (payload.mode === 'resume' && 'adapterSessionId' in payload) {
    return payload.adapterSessionId as string;
  }
  return undefined;
}

/**
 * Explain a refusal in terms the dispatching caller can act on.
 *
 * The outcome name is carried through rather than translated: a caller that
 * degrades has to distinguish "someone else owns this provider session" from
 * "this authority cannot decide", and collapsing them into one sentence would
 * take that decision away from the layer entitled to make it.
 * @param resumeProviderSessionId - Provider session the start wanted to resume
 * @param outcome - What the authority answered
 * @returns Message for the `not-dispatched` refusal
 */
function describeReservationRefusal(
  resumeProviderSessionId: string,
  outcome: SessionOwnershipReserveStartServiceResult['outcome'],
): string {
  return `Provider session ${resumeProviderSessionId} was not reserved for this start: ${outcome}`;
}

/**
 * Reserve the provider session an adapter-owned resume start will resume.
 *
 * Issued as a **hard** request. An adapter that can dispatch a start and cannot
 * reserve one is a broken composition, not a lightweight host: the adapter
 * subsystem declares the session package that registers the authority, so a load
 * set carrying one without the other is rejected before any start runs. A
 * degrade here would make that misconfiguration indistinguishable from a
 * supported topology, and every start it let through would dispatch a resume
 * onto a provider session this runtime does not own.
 *
 * Reserved as a `member`: an adapter never designates a session's lead. That
 * designation flows from the `session.agent.added` event the start emits once it
 * lands, through the single writer that owns it.
 *
 * **This path reserves but never settles, and that is the design.** A connector
 * can land on a provider session other than the one that was reserved — the
 * provider declines the resume and mints its own — and the reservation then has
 * to move onto the confirmed key. It does, through the movement observer: the
 * agent announces its confirmed identity on the movement seam, and the
 * authority's settle allocates the successor on the confirmed key and deletes
 * the predecessor in one transaction, exactly as the caller-owned paths' own
 * settle does. Adding a second settle producer here would race the observer's
 * per-agent queue for the same movement and would put currency-writing
 * knowledge into every adapter, which is what keeping `startAgent`'s contract
 * surface unchanged bought.
 *
 * What that leaves open is a *window*, not a lost reservation: between the
 * connector confirming a new key and its first announcement, the live key
 * carries no claim. That is ignorance of an unclaimed key — survivable, and
 * unchanged from before this seam existed, since neither key was claimed then.
 * It is not the case ownership forbids, which is dispatching *after* storage has
 * named a foreign owner.
 * @param bus - Global bus carrying the session namespace
 * @param request - Agent, session, live adapter identity and resume target
 * @returns The reservation, or the reason the start must not dispatch
 */
export async function reserveAdapterOwnedStart(
  bus: IMakaioBus,
  request: {
    readonly agentId: string;
    readonly sessionId: string;
    readonly adapterId: string;
    readonly adapterName: string;
    readonly resumeProviderSessionId: string;
  },
): Promise<AdapterStartReservationResult> {
  const reserved = await reserveStartFor(bus, {
    sessionId: request.sessionId,
    agentId: request.agentId,
    adapterName: request.adapterName,
    // **No machine, deliberately.** The adapter is not acting *for* a machine
    // some caller named; it is the runtime that owns the instance, so the
    // authority decides under the identity it was composed with and there are no
    // two identities to mix (Wave 3 §5.1, Path C).
    instance: { adapterId: request.adapterId },
    role: 'member',
    resumeProviderSessionId: request.resumeProviderSessionId,
  });
  if (reserved.outcome !== 'reserved') {
    return { kind: 'refused', message: describeReservationRefusal(request.resumeProviderSessionId, reserved.outcome) };
  }
  const { claim } = reserved.reservation;
  if (claim === null) {
    // A keyed reservation always allocates a generation, so this is the shape a
    // claim-less answer has to be given: refusing costs nothing, because a
    // member reservation without a claim holds nothing to release, whereas
    // dispatching would start a resume with no ownership anchor at all.
    return {
      kind: 'refused',
      message: `Provider session ${request.resumeProviderSessionId} was reserved without a claim, so this start has no ownership anchor`,
    };
  }
  return { kind: 'reserved', reservation: { agentId: request.agentId, claimToken: claim.claimToken } };
}

/**
 * Give one generation back, best-effort.
 *
 * Failures are logged and swallowed: this runs on the way out of a failed
 * start, and a cleanup that threw would replace the error the caller is about
 * to see with one about the cleanup.
 * @param bus - Bus the release is issued on
 * @param agentId - Agent whose claim is given up
 * @param claimToken - The one generation this attempt took
 * @param disposition - The caller's evidence, never inferred here
 */
async function releaseReservedGeneration(
  bus: IMakaioBus,
  agentId: string,
  claimToken: string,
  disposition: AdapterSessionClaimDisposition,
): Promise<void> {
  try {
    await bus.requestOptional(SessionSubjects.ownership.release, { agentId, claimToken, disposition });
  } catch (error) {
    console.debug(`[adapter.startAgent] release for agent ${agentId} failed:`, error);
  }
}

/**
 * Settle the pre-dispatch agent row of a start that failed.
 *
 * A start that never reached the provider deletes its row; one that may have
 * reached it keeps the row and compare-and-swaps it to `dead`. The difference is
 * not bookkeeping: deleting the row cascades its claims away, which **frees the
 * ownership key** for a provider session that may still be live behind a
 * connector this adapter can no longer account for.
 * @param bus - Bus the write is issued on
 * @param agentId - Agent whose row is settled
 * @param dispatched - Whether the provider-touching call was entered
 */
async function settleFailedStartRow(bus: IMakaioBus, agentId: string, dispatched: boolean): Promise<void> {
  try {
    if (dispatched) {
      await bus.requestOptional(AgentStorageSubjects.updateStatus, {
        agentId,
        status: 'dead',
        expectedStatus: ['starting'],
      });
      return;
    }
    await bus.requestOptional(AgentStorageSubjects.delete, { agentId });
  } catch (error) {
    console.debug(`[adapter.startAgent] settling the row of failed start ${agentId} failed:`, error);
  }
}

/**
 * Give back everything an adapter-owned start acquired before it failed.
 *
 * Ordered so each step can still find what it needs: the durable release names
 * the reservation's own token while the agent row still exists — a deleted row
 * cascades its claims away and would erase the disposition — and the row is
 * settled before the process-local claims, which are pure memory and cannot
 * fail.
 *
 * The disposition follows `dispatched`, which is set at the **entry** of the
 * provider-touching call rather than at its return. The adapter cannot see how
 * far its own dispatch got, and the safe direction is to over-report reach: an
 * unnecessary `abandoned` costs one blocked key, whereas an unwarranted
 * `released` frees a key for a live connector.
 * @param deps - Bus, registry and everything acquired so far
 */
export async function releaseStartAcquisitions(deps: {
  /** Bus every durable step is issued on. */
  readonly globalBus: IMakaioBus;
  /** Registry holding this start's process-local claims. */
  readonly registry: StartAcquisitionRegistry;
  /** Agent the start was for. */
  readonly agentId: string;
  /** Whether this start holds an unsettled agent-identity claim. */
  readonly claimedIdentity: boolean;
  /** Provider session this start claimed locally, when it claimed one. */
  readonly resumeAdapterSessionId: string | undefined;
  /** The durable reservation, when one was committed. */
  readonly reservation: AdapterStartReservation | undefined;
  /** When the pre-dispatch agent row was created, when the write was issued. */
  readonly agentRowCreatedAt: number | undefined;
  /** Whether the provider-touching call was entered. */
  readonly dispatched: boolean;
}): Promise<void> {
  const { globalBus, registry, agentId, reservation, dispatched } = deps;
  if (reservation !== undefined) {
    await releaseReservedGeneration(globalBus, agentId, reservation.claimToken, dispatched ? 'abandoned' : 'released');
  }
  if (deps.agentRowCreatedAt !== undefined) await settleFailedStartRow(globalBus, agentId, dispatched);
  if (deps.resumeAdapterSessionId !== undefined) registry.releaseAdapterSessionClaim(deps.resumeAdapterSessionId);
  if (deps.claimedIdentity) registry.releaseAgentIdentityClaim(agentId);
}

/** Bus and registry a start gives its acquisitions back through. */
type StartAcquisitionDeps = PersistEmitDeps & { registry: StartAcquisitionRegistry };

/**
 * Answer a refusal taken before anything reached the provider.
 *
 * Gives back everything acquired so far first, so a caller that reads
 * `not-dispatched` finds no row, no generation and no claim behind it.
 * @param deps - Bus and registry the acquisitions are given back through
 * @param agentId - Agent the start was for
 * @param acquisitions - What the attempt took before it refused
 * @param message - Why the start refused
 * @returns The refusal to answer with
 */
export async function refuseUndispatchedStart(
  deps: StartAcquisitionDeps,
  agentId: string,
  acquisitions: StartAcquisitions,
  message: string,
): Promise<StartAgentRefusal> {
  await releaseStartAcquisitions({ globalBus: deps.globalBus, registry: deps.registry, agentId, ...acquisitions });
  return { success: false, dispatch: 'not-dispatched', message };
}

/**
 * Fail a reserved start whose agent row could not be written after registration.
 *
 * The one post-dispatch failure the adapter can describe, so it answers rather
 * than throws: the connector is registered, and a caller that gets an exception
 * cannot tell whether one exists. The reservation is retired as `abandoned` and
 * the row is kept as `dead`, because the dispatch may have reached the provider.
 *
 * The connector is stopped through `evictSilently` rather than a disposal:
 * disposal writes `disposed`, which is terminal, and would contradict the `dead`
 * row this cleanup just wrote.
 * @param deps - Bus and registry the acquisitions are given back through
 * @param agentId - Agent the start was for
 * @param acquisitions - What the attempt took, with `dispatched` already set
 * @param message - Why the persistence failed
 * @returns The refusal to answer with
 */
export async function failStartAfterRegistration(
  deps: StartAcquisitionDeps,
  agentId: string,
  acquisitions: StartAcquisitions,
  message: string,
): Promise<StartAgentRefusal> {
  await releaseStartAcquisitions({ globalBus: deps.globalBus, registry: deps.registry, agentId, ...acquisitions });
  await deps.registry.evictSilently(agentId);
  return { success: false, dispatch: 'dispatch-uncertain', message };
}

/**
 * Refuse an ephemeral start that names a provider session to resume.
 *
 * The combination is already invalid at the contract — `StartAgentSchema`
 * refines `ephemeral` to `create` mode — and this is deliberately a second,
 * independent refusal rather than trust in that.
 *
 * **The exemption is an ownership decision, and an ownership decision may not
 * rest on the validation layer.** What `ephemeral` buys a start is the right to
 * skip session and agent storage, and reaching this point means the start would
 * also skip the *reservation* — the only evidence that no other runtime is
 * driving the provider session it named. A payload that arrives without
 * validation (an in-process handler call, a host that dispatches the resolved
 * payload itself) would take that exemption silently, and the harm is precisely
 * the one this module exists to prevent: a live connector on a provider session
 * no generation accounts for. A schema error is a message to the caller; this is
 * the invariant, and it belongs where the acquisition is made.
 *
 * Refused rather than reserved: reserving would mean writing the pre-dispatch
 * agent row for an agent whose contract is that no such row exists, which trades
 * one broken invariant for another.
 * @param deps - Bus and registry the acquisitions are given back through
 * @param agentId - Agent the start was for
 * @param acquisitions - What the attempt took before it refused
 * @param adapterSessionId - Provider session the ephemeral start named
 * @returns The refusal to answer with
 */
async function refuseEphemeralResume(
  deps: StartAcquisitionDeps,
  agentId: string,
  acquisitions: StartAcquisitions,
  adapterSessionId: string,
): Promise<StartAgentRefusal> {
  return refuseUndispatchedStart(
    deps,
    agentId,
    acquisitions,
    `An ephemeral start may not resume provider session ${adapterSessionId}: it takes no ownership of it`,
  );
}

/**
 * Take everything a start must own before it may touch the provider.
 *
 * Two claims for one start, and they answer different questions. The
 * process-local claim refuses a same-process collision without a storage round
 * trip and is the source `listAgents` reports occupancy from; the durable
 * reservation is the only evidence that no *other* runtime owns the provider
 * session. Neither replaces the other.
 *
 * The reservation is taken exactly when the adapter owns the agent row and the
 * start names a key to reserve. Everything else mints its provider identity
 * inside the provider and has nothing to name here — which is why an
 * **ephemeral** start, whose whole definition is that it touches neither session
 * nor agent storage, is refused rather than exempted once it does name one: see
 * {@link refuseEphemeralResume}.
 * @param deps - Adapter identity, bus and registry
 * @param params - The start being run, and its acquisition state
 * @returns The refusal to answer with, or `undefined` once the start may dispatch
 */
export async function acquireStartOwnership(
  deps: StartAcquisitionDeps,
  params: {
    payload: ResolvedStartPayload;
    agentId: string;
    sessionId: string;
    acquisitions: StartAcquisitions;
  },
): Promise<StartAgentRefusal | undefined> {
  const { payload, agentId, sessionId, acquisitions } = params;
  const adapterSessionId = getResumeAdapterSessionId(payload);
  if (adapterSessionId === undefined) return undefined;

  if (!deps.registry.claimAdapterSession(adapterSessionId)) {
    // Fires before the connector is created, so nothing exists provider-side.
    const message = `Provider session ${adapterSessionId} is already claimed by another in-flight start`;
    return refuseUndispatchedStart(deps, agentId, acquisitions, message);
  }
  acquisitions.resumeAdapterSessionId = adapterSessionId;
  if (payload.ephemeral === true) {
    return refuseEphemeralResume(deps, agentId, acquisitions, adapterSessionId);
  }
  if (callerOwnsAgentRow(payload)) return undefined;

  // Recorded before the write is issued, not after it returns: see
  // `StartAcquisitions.agentRowCreatedAt`. It is also the timestamp the row
  // carries, so the post-dispatch whole-record write can restate it rather than
  // mint a new one.
  const agentRowCreatedAt = Date.now();
  acquisitions.agentRowCreatedAt = agentRowCreatedAt;
  await writePreDispatchAgentRow({ agentId, sessionId, adapterSessionId, payload, createdAt: agentRowCreatedAt }, deps);
  const outcome = await reserveAdapterOwnedStart(deps.globalBus, {
    agentId,
    sessionId,
    adapterId: deps.adapterId,
    adapterName: deps.name,
    resumeProviderSessionId: adapterSessionId,
  });
  if (outcome.kind === 'refused') {
    return refuseUndispatchedStart(deps, agentId, acquisitions, outcome.message);
  }
  acquisitions.reservation = outcome.reservation;
  return undefined;
}
