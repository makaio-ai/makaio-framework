/**
 * The one place a start reservation is asked for.
 *
 * Four paths reserve before they dispatch — the fresh lead start, the reserved
 * attach, the reserved rehydrate and the adapter's own resume start — and each
 * built the same payload by hand, including the same conditional spread of the
 * machine identity. Four hand-built copies of one identity rule is four chances
 * to state one of its halves differently, and the half that goes missing is
 * always the machine: it is the optional one.
 *
 * So the payload is built once, from {@link OwnedAdapterInstance} — the pair the
 * resolver hands out — and the machine travels with the instance because they
 * arrive in the same object rather than as two arguments a call site may forget
 * to keep together.
 * @packageDocumentation
 */
import type { IMakaioBus } from '@makaio/bus-core';
import {
  SessionSubjects,
  type AgentRole,
  type SessionOwnershipRecoveryGuard,
  type SessionOwnershipReserveStartServiceResult,
} from '@makaio/contracts';
import type { OwnedAdapterInstance } from './resolution.js';

/** Adapter identity sufficient to route every reservation to one authority. */
type ReservationAdapterInstance = OwnedAdapterInstance & { readonly ownerInstanceId: string };

/** What every start reservation names, whatever role it takes. */
interface StartReservationIdentity {
  /** Session the agent belongs to; verified against the agent row by the authority. */
  readonly sessionId: string;
  /** Agent the reservation is taken for. */
  readonly agentId: string;
  /** Adapter type name carried onto any claim for diagnostics. */
  readonly adapterName: string;
  /** Instance the dispatch addresses, and the machine its ownership acts are filed under. */
  readonly instance: ReservationAdapterInstance;
  /** Provider session to reserve, or `null` for a start with no key yet. */
  readonly resumeProviderSessionId: string | null;
  /** Caller-minted identity for the reservation generation. */
  readonly claimToken: string;
}

/**
 * The designation half, as a union rather than an optional field.
 *
 * A lead reservation is a compare-and-swap and must name the exact value the
 * caller read; `null` is a legitimate observation ("the session named no lead")
 * and therefore cannot double as "not supplied". Modelling it as one optional
 * field would make the authority's own refusal — *`expectedLeadAgentId` is
 * required when role is `'lead'`* — reachable from these four callers, which is
 * exactly what a union makes impossible to write.
 */
type StartReservationDesignation =
  | {
      /** This start designates the session's lead. */
      readonly role: Extract<AgentRole, 'lead'>;
      /** Lead the caller observed on the session row, or `null` when it named none. */
      readonly expectedLeadAgentId: string | null;
    }
  | {
      /** This start leaves the designation untouched. */
      readonly role: Exclude<AgentRole, 'lead'>;
    };

/** Everything a start reservation names beyond the instance it runs against. */
export type StartReservationRequest = StartReservationIdentity &
  StartReservationDesignation & {
    /** Atomic snapshot for a member recovery; absent for ordinary starts. */
    readonly recoveryGuard?: SessionOwnershipRecoveryGuard;
    /** Opaque fence for this guarded recovery attempt. */
    readonly recoveryAttemptId?: string;
  };

/**
 * Take one start reservation.
 *
 * Issued as a **hard** request by every caller, and that is deliberate rather
 * than incidental: a host that can dispatch a start and cannot reserve one is a
 * broken composition, not a lightweight one, and a degrade here would make that
 * misconfiguration indistinguishable from a supported topology. Each caller owns
 * what a throw means for its own rollback, so no attempt is made to classify it
 * here.
 * @param bus - Bus the reservation is issued on.
 * @param request - Identity, instance, role and resume target of the start being reserved for.
 * @returns What the authority answered, verbatim.
 */
export async function reserveStartFor(
  bus: IMakaioBus,
  request: StartReservationRequest,
): Promise<SessionOwnershipReserveStartServiceResult> {
  const { instance } = request;
  return bus.request(SessionSubjects.ownership.reserveStart, {
    sessionId: request.sessionId,
    agentId: request.agentId,
    adapterId: instance.adapterId,
    adapterName: request.adapterName,
    ownerInstanceId: instance.ownerInstanceId,
    role: request.role,
    resumeProviderSessionId: request.resumeProviderSessionId,
    claimToken: request.claimToken,
    ...(request.recoveryGuard !== undefined && { recoveryGuard: request.recoveryGuard }),
    ...(request.recoveryAttemptId !== undefined && { recoveryAttemptId: request.recoveryAttemptId }),
    ...(request.role === 'lead' && { expectedLeadAgentId: request.expectedLeadAgentId }),
    ...(instance.machineId !== undefined && { machineId: instance.machineId }),
  });
}
