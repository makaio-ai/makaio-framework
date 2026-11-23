import type { IMakaioBus } from '@makaio/bus-core';
import type { CallContext, OptionalResult } from '@makaio/core';
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
  call: CallContext,
  payload: ClientSessionAccountObserveRequest,
) => Promise<OptionalResult<ClientSessionAccountObserveResponse>>;

/**
 * Build a requester for Claude session account observations.
 * @param bus - Bus used to send the observation request.
 * @returns Requester that forwards the caller's `call` and preserves `requestOptional()` semantics.
 */
export function createSessionAccountObservationRequester(bus: IMakaioBus): RequestSessionAccountObservation {
  return (call, payload) => bus.requestOptional(call, ClientSubjects.session.account.observe, payload);
}
