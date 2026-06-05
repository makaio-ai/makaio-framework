import type { SubjectDefinition } from '@makaio/core';
import type { BusTransportRegistry } from '../registries/index.js';
import type { MakaioBusContext } from '../types/index.js';

type TransportSpec = Set<keyof BusTransportRegistry> | Array<keyof BusTransportRegistry>;

/**
 * Resolve the effective transports for an outbound message by checking the
 * defaultTransports cascade.
 *
 * Precedence (highest first):
 * 1. Caller-supplied `transports` option (explicit override, including `[]`)
 * 2. Subject-level `$meta.defaultTransports` (set on the subject definition token)
 * 3. Namespace-level `defaultTransports` stored in the registry
 * 4. Implicit `'all'` — current bus default when none of the above is set
 *
 * Returns `[]` when the resolved default is `'local-only'`, which causes
 * downstream dispatch logic to suppress all transport fan-out.
 * @param context - Makaio bus context (for registry access)
 * @param subjectDefinition - Subject definition token, carries subject-level meta
 * @param fullSubjectKey - Pre-computed fully-qualified subject key
 * @param callerTransports - Explicit `transports` option from the call site, if any
 * @returns The resolved transports value — passthrough when caller-supplied, `[]` for local-only, `undefined` for all
 */
export function resolveEffectiveTransports(
  context: MakaioBusContext,
  subjectDefinition: SubjectDefinition,
  fullSubjectKey: string,
  callerTransports: TransportSpec | undefined,
): TransportSpec | undefined {
  if (callerTransports !== undefined) {
    return callerTransports;
  }

  const subjectLevelDefault = subjectDefinition.$meta.defaultTransports;
  if (subjectLevelDefault !== undefined) {
    return subjectLevelDefault === 'local-only' ? [] : undefined;
  }

  const namespaceLevelDefault = context.namespaceRegistry.getDefaultTransports(fullSubjectKey);
  if (namespaceLevelDefault === 'local-only') {
    return [];
  }

  return undefined;
}
