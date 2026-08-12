import type { IMakaioBus } from '@makaio/bus-core';
import { SessionSubjects, type AgentRole, type SessionOwnershipReservation } from '@makaio/contracts';
import { mintClaimToken } from '../ownership/claim-token.js';
import { reserveStartFor } from '../utils/start-reservation.js';
import type { MachineScopedAdapterInstance } from '../utils/resolution.js';

/**
 * How the reservation an attach runs under was answered.
 *
 * The verdict this produces is the **final** one: a structurally native attach
 * whose key is held by a generation this runtime does not own becomes
 * non-native here, and nowhere else. Everything downstream — the resume target,
 * the history seeding, the degrade event — reads it from this result rather
 * than from the structural evaluator.
 */
export type AttachReservationResult =
  | {
      /**
       * The start may proceed. A reservation carrying a claim is a native
       * resume; one carrying `claim: null` was keyless, because the structural
       * verdict was already non-native and there was no key to take.
       */
      readonly kind: 'reserved';
      readonly reservation: SessionOwnershipReservation;
    }
  | {
      /**
       * The provider session is held elsewhere, or this host cannot name the
       * machine the key belongs to. Either way the attach continues
       * fresh-with-history rather than speaking to a session it does not own.
       */
      readonly kind: 'degrade';
      readonly reason: 'agent-already-started';
      /**
       * Keyless authorization selecting the runtime incarnation for the fresh dispatch.
       * A lead also takes its designation through this reservation.
       */
      readonly reservation: SessionOwnershipReservation;
    }
  | {
      /** Another start holds the designation this attach expected to take. */
      readonly kind: 'conflict';
      readonly currentLeadAgentId: string | null;
    }
  | {
      /**
       * The row this attempt wrote a moment ago is gone or terminal, which can
       * only be a concurrent delete.
       *
       * DEVIATION from §3.3's three-member union: `agent-disposed` and
       * `not-found` are refusals the caller must raise `AttachStartError` for
       * (§7.2's outcome table), and folding them into `degrade` would let an
       * attach continue against a row that no longer exists.
       */
      readonly kind: 'refused';
      readonly outcome: 'agent-disposed' | 'not-found';
    }
  | {
      /** The session's lifecycle gate closed before this start was admitted. */
      readonly kind: 'refused';
      readonly outcome: 'session-not-active';
      /** Actual non-active session status observed by the reservation. */
      readonly status: 'closed' | 'archived' | 'discovered';
    };

/** Everything a reserved attach's reservation is taken for. */
export interface AttachReservationRequest {
  /** Session the agent is attached to. */
  readonly sessionId: string;
  /** Caller-minted agent identity, already persisted as `starting`. */
  readonly agentId: string;
  /**
   * Live adapter instance the start is dispatched to, and the machine its
   * ownership acts are filed under — one value, because it is one key.
   */
  readonly instance: MachineScopedAdapterInstance;
  /** Adapter type name every ownership act names. */
  readonly adapterName: string;
  /** Role the attach takes; only a lead writes a designation. */
  readonly role: AgentRole;
  /** Provider session the structural verdict resolved, or `null` when it is already non-native. */
  readonly resumeProviderSessionId: string | null;
  /** Lead the caller observed on the session row, or `null` when it names none. */
  readonly expectedLeadAgentId: string | null;
}

/**
 * Reserve the provider session an attach intends to resume — and, for a lead,
 * the designation that goes with it.
 *
 * Issued as a **hard** request. An absent authority is a broken composition
 * rather than a lightweight host, and an attach dispatched without one is the
 * unowned second writer this aggregate exists to prevent. The caller catches the
 * throw and runs the pre-dispatch rollback before it propagates.
 *
 * **This replaces the live-writer probe.** A probe could never decide the case
 * it existed for — an abandoned provider session is by definition the one no
 * live agent claims — and this reservation decides exactly that case, against
 * the claim row, inside the transaction that acts on it.
 *
 * **A degraded lead reserves a second time, keyless.** Stated rather than
 * hidden, because two RPCs are two transactions: between them the designation
 * may move, and the keyless compare-and-swap is what refuses a stale one — a
 * `lead-conflict`, not an overwrite.
 * @param bus - Bus the reservation is issued on.
 * @param request - The attach being reserved for.
 * @returns The final verdict this attach dispatches under.
 */
export async function reserveAttachStart(
  bus: IMakaioBus,
  request: AttachReservationRequest,
): Promise<AttachReservationResult> {
  const reserved = await requestReservation(bus, request, request.resumeProviderSessionId);
  switch (reserved.outcome) {
    case 'reserved':
      return { kind: 'reserved', reservation: reserved.reservation };
    case 'lead-conflict':
      return { kind: 'conflict', currentLeadAgentId: reserved.currentLeadAgentId };
    case 'agent-disposed':
    case 'not-found':
      return { kind: 'refused', outcome: reserved.outcome };
    case 'session-not-active':
      return { kind: 'refused', outcome: reserved.outcome, status: reserved.status };
    case 'occupied':
    case 'machine-identity-unavailable':
      return degradeAttachStart(bus, request);
    case 'currency-changed':
    case 'recovery-conflict':
      // Unreachable: attach reservations never carry a recovery guard.
      return { kind: 'refused', outcome: 'not-found' };
  }
}

/**
 * Take the keyless authorization every degraded attach still needs.
 *
 * A member has no key or designation left to reserve, but still needs the
 * authority's current incarnation to target its fresh dispatch exactly. A lead
 * additionally takes its designation through the same keyless reservation.
 * @param bus - Bus the reservation is issued on.
 * @param request - The attach being reserved for.
 * @returns The degrade carrying the authority-selected runtime incarnation.
 */
async function degradeAttachStart(
  bus: IMakaioBus,
  request: AttachReservationRequest,
): Promise<AttachReservationResult> {
  const degraded = { kind: 'degrade', reason: 'agent-already-started' } as const;
  const reserved = await requestReservation(bus, request, null);
  switch (reserved.outcome) {
    case 'reserved':
      return { ...degraded, reservation: reserved.reservation };
    case 'lead-conflict':
      return { kind: 'conflict', currentLeadAgentId: reserved.currentLeadAgentId };
    case 'agent-disposed':
    case 'not-found':
      return { kind: 'refused', outcome: reserved.outcome };
    case 'session-not-active':
      return { kind: 'refused', outcome: reserved.outcome, status: reserved.status };
    case 'occupied':
    case 'machine-identity-unavailable':
      // Unreachable: a keyless reservation takes no key and reads no
      // machine-scoped triple. Reported as a refusal rather than narrowed away,
      // because to a caller it means what the other refusals mean — the
      // designation this attach asked for was not written.
      return { kind: 'refused', outcome: 'not-found' };
    case 'currency-changed':
    case 'recovery-conflict':
      // Unreachable: the keyless designation carries no recovery guard.
      return { kind: 'refused', outcome: 'not-found' };
  }
}

/**
 * Issue one reservation for this attach.
 * @param bus - Bus the reservation is issued on.
 * @param request - The attach being reserved for.
 * @param resumeProviderSessionId - Key to take, or `null` for a keyless reservation.
 * @returns What the authority answered.
 */
async function requestReservation(
  bus: IMakaioBus,
  request: AttachReservationRequest,
  resumeProviderSessionId: string | null,
) {
  const claimToken = mintClaimToken();
  try {
    return await reserveStartFor(bus, {
      sessionId: request.sessionId,
      agentId: request.agentId,
      adapterName: request.adapterName,
      instance: request.instance,
      resumeProviderSessionId,
      claimToken,
      ...(request.role === 'lead'
        ? { role: request.role, expectedLeadAgentId: request.expectedLeadAgentId }
        : { role: request.role }),
    });
  } catch (error) {
    await bus
      .requestOptional(SessionSubjects.ownership.release, {
        agentId: request.agentId,
        claimToken,
        disposition: 'released',
      })
      .catch(() => undefined);
    throw error;
  }
}
