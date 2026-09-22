import { BusTransportRegistry } from '../../registries/index.js';
import type { BusMessage, MakaioBusContext, BusTransport } from '../../types/index.js';
import { getFullSubjectForSubjectDefinition } from '../../utils/subject-transformation.js';
import { getReadyTransports } from '../../utils/transport.js';
import type { SubjectDefinition } from '@makaio/core';

/**
 * Check whether a caller supplied an explicit local-only transport spec.
 * @param transports - Optional transport allowlist from bus call options.
 * @returns True for `[]` or an empty Set.
 */
export function isExplicitLocalOnlyTransportSpec(
  transports: Set<keyof BusTransportRegistry> | Array<keyof BusTransportRegistry> | undefined,
): boolean {
  if (transports === undefined) return false;
  return Array.isArray(transports) ? transports.length === 0 : transports.size === 0;
}

/**
 * Resolve which transports a message should be sent to.
 *
 * Outbound routing semantics:
 *
 * - `undefined` — send to all **ready or eligible** transports (no subscription
 *   filtering). Subscriptions are an inbound concern: they tell the server which
 *   subjects to forward back to this client. They must not gate outbound sends — a
 *   client may emit events it does not subscribe to (e.g., Electron emits
 *   `window.opened` without listening to it). When `message` is provided, transports
 *   with `canSend` are filtered per-message; otherwise the message-agnostic `isReady`
 *   check applies. This matches how `request()` and `broadcast()` dispatch via
 *   `getSortedTransports` without subscription filtering.
 * - `[]` / empty Set — local-only (no transport dispatch)
 * - named transports — exact lookup, no subscription filtering
 *
 * Local subjects (marked with `localSubject()` at schema definition) and
 * collector-only subjects always return an empty array, regardless of the
 * `transports` option.
 * @param context - Bus context containing the transport registry
 * @param transports - Explicit transport specification from options
 * @param subjectDefinition - Subject definition, used for local-subject guard
 *   and subject key resolution
 * @param message - Optional outbound bus message; when provided, per-message
 *   eligibility via `canSend` is applied so relay codecs can pass control-plane
 *   frames before their E2E session is established
 * @returns Array of transport instances to send to
 */
export function normalizeTransportTargets(
  context: MakaioBusContext,
  transports: Set<keyof BusTransportRegistry> | Array<keyof BusTransportRegistry> | undefined,
  subjectDefinition: SubjectDefinition,
  message?: BusMessage,
): BusTransport[] {
  // Local subjects never go to transports
  if (subjectDefinition.$meta.local) {
    return [];
  }

  const subject = getFullSubjectForSubjectDefinition(subjectDefinition);
  if (context.namespaceRegistry.isCollectorOnlySubject(subject)) {
    return [];
  }

  // undefined: send to all eligible transports (no subscription filtering), unless
  // the subject's $meta declares a 'local-only' default. In that case an absent
  // explicit transports option is treated as local-only suppression — callers can
  // still force transport delivery by passing an explicit non-empty list.
  // When a message is provided, per-message eligibility (canSend) is applied so that
  // relay codecs can pass control-plane frames before their E2E session is established.
  if (transports === undefined) {
    if (subjectDefinition.$meta.defaultTransports === 'local-only') {
      return [];
    }
    return getReadyTransports(context, undefined, message).map(({ transport }) => transport);
  }

  // Empty array/set: don't send to any transports (local only)
  const transportNames = Array.isArray(transports) ? transports : Array.from(transports);

  if (isExplicitLocalOnlyTransportSpec(transports)) {
    return [];
  }

  // Specific transports: get instances (no subscription filtering)
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
