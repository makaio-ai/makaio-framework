import type { IMakaioBus } from '@makaio/bus-core';
import { canonicalStringify } from '@makaio/utils';
import { AccessDeniedError, AccessSubjects } from '@makaio/contracts/access';
import type { AccessDenied, DenialPlace } from '@makaio/contracts/access';
import type { SubjectName } from '@makaio/contracts/journal';
import type { CallContext, CallContextRecord, ContributionName } from '@makaio/core';
import type { RightName } from '@makaio/contracts/rights';

/**
 * Fire-and-forget local diagnostic sink.
 * @param denied - The denial to announce.
 */
export type DenialEmitter = (denied: AccessDenied) => void;

/**
 * Select the serializable caller, principal, and attester.
 * @param call - Call context of the denied question.
 * @returns The serialisable record of `call`.
 */
function callContextToRecord(call: CallContext): CallContextRecord {
  return {
    caller: call.caller,
    principal: call.principal,
    ...(call.attestedBy === undefined ? {} : { attestedBy: call.attestedBy }),
  };
}

/**
 * Diagnostic fields available at the denial place.
 */
export interface Denial {
  /** Call context of the denied call, when one was minted for it; becomes the denial's `ctx`. */
  readonly call?: CallContext;
  /** The right that was asked, when the denial is about one. */
  readonly right?: RightName;
  /** The subject concerned, when the denial is about one. */
  readonly subject?: SubjectName;
  /** Why the call was denied. */
  readonly reason: string;
  /** The verifier or answer source that denied, when known. */
  readonly by?: ContributionName;
}

/**
 * Publish a local diagnostic and return the corresponding wire-safe denial.
 * @param emit - Sink the built `AccessDenied` is handed to, fire-and-forget.
 * @param place - The place where the denial arose.
 * @param denial - What is known of the denial; see {@link Denial}.
 * @returns The error the denied caller gets, built from the same denial minus its `ctx`.
 */
export function deny(emit: DenialEmitter, place: DenialPlace, denial: Denial): AccessDeniedError {
  const denied: AccessDenied = {
    at: place,
    ...(denial.call === undefined ? {} : { ctx: callContextToRecord(denial.call) }),
    ...(denial.right === undefined ? {} : { right: denial.right }),
    ...(denial.subject === undefined ? {} : { subject: denial.subject }),
    reason: denial.reason,
    ...(denial.by === undefined ? {} : { by: denial.by }),
  };

  emit(denied);

  const { ctx: _ctx, ...forbidden } = denied;
  return new AccessDeniedError(forbidden);
}

/**
 * Suppress reentrant publication of the same denial while retaining distinct diagnoses.
 * @param bus - Bus every denial is emitted on, with a fresh `bus.own('observer')` context.
 * @returns The emitter.
 */
export function createDenialEmitter(bus: IMakaioBus): DenialEmitter {
  const publishingDenials = new Set<string>();

  return (denied) => {
    const key = canonicalStringify(denied);
    if (publishingDenials.has(key)) return;
    publishingDenials.add(key);
    const settle = (): void => {
      publishingDenials.delete(key);
    };
    try {
      void bus
        .emit(bus.own('observer'), AccessSubjects.denied, denied)
        .catch((err: unknown) => {
          console.error('[RightsHub] makaio:access.denied emission failed:', err);
        })
        .finally(settle);
    } catch (err) {
      console.error('[RightsHub] makaio:access.denied emission failed:', err);
      settle();
    }
  };
}
