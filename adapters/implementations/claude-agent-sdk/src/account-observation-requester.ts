import type { OptionalResult } from '@makaio/core';
import {
  ClientSubjects,
  type ClientSessionAccountObserveRequest,
  type ClientSessionAccountObserveResponse,
} from '@makaio/contracts/client';

/**
 * Cross-namespace requester used by the Claude connector to forward account
 * observations to the session linker without depending on a global bus singleton.
 */
export type RequestSessionAccountObservation = (
  payload: ClientSessionAccountObserveRequest,
) => Promise<OptionalResult<ClientSessionAccountObserveResponse>>;

interface SessionAccountObservationRequestBus {
  requestOptional: (
    subject: typeof ClientSubjects.session.account.observe,
    payload: ClientSessionAccountObserveRequest,
  ) => Promise<OptionalResult<ClientSessionAccountObserveResponse>>;
}

/**
 * Build a requester for Claude session account observations.
 * @param bus - Bus exposing the observation request subject.
 * @returns Requester that preserves `requestOptional()` semantics.
 */
export function createSessionAccountObservationRequester(
  bus: SessionAccountObservationRequestBus,
): RequestSessionAccountObservation {
  return (payload) => bus.requestOptional(ClientSubjects.session.account.observe, payload);
}
