import type { AllocationScope, AllocationScopeBlockReason } from '@makaio/contracts';
import type { AllocationScopeSetting } from './allocation-scope-source.js';

/** The installation scope or the reason provider-managed activation is blocked. */
export type AllocationScopeDecision =
  | { readonly kind: 'bound'; readonly scope: AllocationScope }
  | { readonly kind: 'blocked'; readonly reason: AllocationScopeBlockReason };

/**
 * Mint an installation scope only when the operator setting matches the confirmed binding.
 * The caller checks that the binding belongs to the installation and designated extension.
 * @param setting - The installation's operator setting.
 * @param confirmedValue - The stored binding, absent before explicit confirmation.
 * @returns The bound scope or the reason activation is blocked.
 */
export function decideAllocationScope(
  setting: AllocationScopeSetting,
  confirmedValue: string | undefined,
): AllocationScopeDecision {
  if (setting.kind === 'absent') return { kind: 'blocked', reason: 'setting-missing' };
  if (setting.kind === 'invalid') return { kind: 'blocked', reason: 'setting-invalid' };
  if (confirmedValue === undefined) return { kind: 'blocked', reason: 'binding-missing' };
  if (confirmedValue !== setting.value) return { kind: 'blocked', reason: 'binding-mismatch' };
  const value: string = setting.value;
  const scope = Object.freeze({ value }) as AllocationScope;
  return { kind: 'bound', scope };
}
