import { mintCallContext } from '@makaio/bus-core/kernel-api';
import type { EventFacts } from '@makaio/contracts/rules';
import { MAKAIO_RULES_PARTY_KIND, type CallContext } from '@makaio/core';

/** Resume an occasion with the same recorded principal and attestation.
 * @param event - Pinned trigger facts, including origin.
 * @returns The kernel-minted rule evaluation call.
 */
export function ruleCall(event: EventFacts): CallContext {
  const { principal, attestedBy } = event.origin;
  return mintCallContext({
    caller: { kind: MAKAIO_RULES_PARTY_KIND, id: MAKAIO_RULES_PARTY_KIND },
    principal,
    ...(attestedBy === undefined ? {} : { attestedBy }),
  });
}
