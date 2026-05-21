import { BusTransportRegistry } from '../../registries/index.js';
import type { MakaioBusContext, BusTransport } from '../../types/index.js';
import { getFullSubjectForSubjectDefinition } from '../../utils/subject-transformation.js';
import { getReadyTransports } from '../../utils/transport.js';
import type { SubjectDefinition } from '@makaio/core';

/**
 * Resolve which transports a message should be sent to.
 *
 * Outbound routing semantics:
 *
 * - `undefined` — send to **all** registered transports (no subscription filtering).
 *   Subscriptions are an inbound concern: they tell the server which subjects to
 *   forward back to this client. They must not gate outbound sends — a client may
 *   emit events it does not subscribe to (e.g., Electron emits `window.opened`
 *   without listening to it). This matches how `request()` and `broadcast()`
 *   dispatch via `getSortedTransports` without filtering.
 * - `[]` / empty Set — local-only (no transport dispatch)
 * - named transports — exact lookup, no subscription filtering
 *
 * Local subjects (marked with `localSubject()` at schema definition) always
 * return an empty array, regardless of the `transports` option.
 * @param context - Bus context containing the transport registry
 * @param transports - Explicit transport specification from options
 * @param subjectDefinition - Subject definition, used for local-subject guard
 *   and subject key resolution
 * @returns Array of transport instances to send to
 */
export function normalizeTransportTargets(
  context: MakaioBusContext,
  transports: Set<keyof BusTransportRegistry> | Array<keyof BusTransportRegistry> | undefined,
  subjectDefinition: SubjectDefinition,
): BusTransport[] {
  // Local subjects never go to transports
  if (subjectDefinition.$meta.local) {
    return [];
  }

  // undefined: send to all ready transports (no subscription filtering).
  // Readiness filtering skips transports that haven't established connectivity
  // (e.g., E2E relay before session key exchange). This matches how request()
  // and broadcast() dispatch via getReadyTransports / getSortedTransports.
  if (transports === undefined) {
    return getReadyTransports(context).map(({ transport }) => transport);
  }

  // Empty array/set: don't send to any transports (local only)
  const transportNames = Array.isArray(transports) ? transports : Array.from(transports);

  if (transportNames.length === 0) {
    return [];
  }

  // Specific transports: get instances (no subscription filtering)
  const subject = getFullSubjectForSubjectDefinition(subjectDefinition);
  const result: BusTransport[] = [];
  for (const name of transportNames) {
    const transport = context.transportRegistry.getTransport(name);
    if (!transport) {
      console.warn(`Transport "${String(name)}" not found for request "${subject}"`);
      continue;
    }
    result.push(transport);
  }

  return result;
}
