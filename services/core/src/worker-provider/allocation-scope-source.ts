import { AllocationScopeValueSchema, type ExtensionOperatorConfigSource } from '@makaio/contracts';

import type { z } from 'zod';

const ParsedAllocationScopeValueSchema = AllocationScopeValueSchema.brand<'AllocationScopeValue'>();

/** The installation scope as configured by the operator. */
export type AllocationScopeSetting =
  | { readonly kind: 'absent' }
  | { readonly kind: 'invalid'; readonly reason: 'entry-unusable' | 'value-malformed' }
  | { readonly kind: 'present'; readonly value: z.infer<typeof ParsedAllocationScopeValueSchema> };

/**
 * Read the scope from the immutable operator entry named by the host.
 * The provider registry is the only consumer of the setting. The designated
 * extension must allow the key in its strict config schema without consuming it.
 * Resolved extension config is outside this lookup.
 * @param operatorConfig - The process-wide operator snapshot.
 * @param designatedExtension - Extension entry holding the installation scope.
 * @returns The operator setting for this installation.
 */
export function readAllocationScopeSetting(
  operatorConfig: ExtensionOperatorConfigSource,
  designatedExtension?: string,
): AllocationScopeSetting {
  const entry = designatedExtension === undefined ? undefined : operatorConfig.get(designatedExtension);
  if (entry === undefined) return { kind: 'absent' };
  if (entry.kind === 'failure') return { kind: 'invalid', reason: 'entry-unusable' };
  if (!Object.hasOwn(entry.config, 'allocationScope')) return { kind: 'absent' };
  const scope = ParsedAllocationScopeValueSchema.safeParse(entry.config['allocationScope']);
  return scope.success ? { kind: 'present', value: scope.data } : { kind: 'invalid', reason: 'value-malformed' };
}
