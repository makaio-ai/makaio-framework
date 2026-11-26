import { HmacAuth } from '@makaio/bus-transport-websocket';
import type { JsonValue, OrderedWorkerBootstrapAuth } from '@makaio/contracts';
import type { OrderedProvisionRequest } from '@makaio/contracts/extension';
import { deepFreeze } from '@makaio/utils';

/**
 * Build the explicit auth configuration passed over an ordered provider's private start channel.
 * @param request - The winning provision request, containing the original bootstrap window.
 * @param replayDeadlineAt - Host policy bounding recovery of a possibly committed presentation.
 * @param proof - Independently verifiable evidence of this worker's allocation.
 * @returns Material for the stock worker's private `orderedBusAuth` launch field.
 */
export function createOrderedWorkerBusAuth(
  request: OrderedProvisionRequest,
  proof: JsonValue,
  replayDeadlineAt: string,
): OrderedWorkerBootstrapAuth {
  return deepFreeze({
    kind: 'exchange',
    jobRunId: request.binding.jobRunId,
    oneTimeToken: request.oneTimeToken,
    bootstrapDeadlineAt: request.bootstrapDeadlineAt,
    replayDeadlineAt,
    proof: structuredClone(proof),
  });
}

/**
 * Build transport authentication without interpreting credentials as grants.
 * @param secret - HMAC secret; undefined means no HMAC authentication.
 * @param identityId - Optional identity for the server's trusted-peer resolver.
 * @returns HMAC authenticator when a secret is supplied.
 */
export function createWorkerBusAuth(secret: string | undefined, identityId?: string): HmacAuth | undefined {
  return secret === undefined ? undefined : new HmacAuth({ secret, ...(identityId !== undefined && { identityId }) });
}
