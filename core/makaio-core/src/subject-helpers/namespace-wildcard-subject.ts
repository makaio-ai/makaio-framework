import { type WildcardSubjectDefinition, WildcardSubjectKey } from '../types/index.js';

/**
 * Builds the namespace-level wildcard subject definition for one namespace.
 *
 * This is the canonical construction of the `$all` wildcard: a namespace exposes
 * exactly one, and every consumer that needs to observe a whole namespace —
 * including code that derives a wildcard from a concrete subject key — must build
 * it through this helper rather than re-stating the literal. The wildcard is
 * always an event subject and never local or channel-bound, because it stands for
 * "every event in this namespace" rather than for any one subject's routing.
 *
 * A wildcard subject resolves to the full subject key `<namespace>.*`, which the
 * bus's subscription matching reads as "every subject directly in this
 * namespace". It deliberately does not cross a `:` namespace-hierarchy boundary.
 * @typeParam Namespace - Namespace the wildcard belongs to.
 * @param namespace - Namespace to build the wildcard for, e.g. `git` or
 *   `storage:workflow`.
 * @returns The wildcard subject definition of that namespace.
 */
export function createNamespaceWildcardSubject<Namespace extends string>(
  namespace: Namespace,
): WildcardSubjectDefinition<Namespace> {
  return {
    subject: WildcardSubjectKey,
    $meta: { namespace, isRequest: false, payload: {}, local: false, channel: false },
  };
}
