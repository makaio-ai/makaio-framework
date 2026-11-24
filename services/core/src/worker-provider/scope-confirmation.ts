import type { CallContextRecord, HostDatabase } from '@makaio/contracts';
import type { AllocationScopeSetting } from './allocation-scope-source.js';
import { writeBindingIfAbsent } from './allocation-scope-store.js';

type Confirmation =
  | { readonly outcome: 'confirmed'; readonly effect: 'restart-required' }
  | { readonly outcome: 'already-confirmed' }
  | {
      readonly outcome: 'refused';
      readonly code: 'setting-missing' | 'setting-invalid' | 'setting-mismatch' | 'bound-to-other-scope';
    };

/**
 * Confirm only the scope designated by the operator and preserve a previous binding.
 * @param database - Host database owning the scope binding transaction.
 * @param setting - Parsed setting from the installation's operator layer.
 * @param requested - Scope repeated by the operator.
 * @param caller - Auditable identity of the authorized caller.
 * @returns The first confirmation, an idempotent repeat, or a typed refusal.
 */
export async function confirmAllocationScope(
  database: HostDatabase,
  setting: AllocationScopeSetting,
  requested: string,
  caller: CallContextRecord,
): Promise<Confirmation> {
  if (setting.kind === 'absent') return { outcome: 'refused', code: 'setting-missing' };
  if (setting.kind === 'invalid') return { outcome: 'refused', code: 'setting-invalid' };
  if (setting.value !== requested) return { outcome: 'refused', code: 'setting-mismatch' };
  const { binding, inserted } = await database.transaction((tx) => writeBindingIfAbsent(tx, setting.value, caller));
  if (inserted) return { outcome: 'confirmed', effect: 'restart-required' };
  return binding.allocationScope === setting.value
    ? { outcome: 'already-confirmed' }
    : { outcome: 'refused', code: 'bound-to-other-scope' };
}
