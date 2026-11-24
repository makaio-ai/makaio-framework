import type { CallContextRecord, HostTransaction } from '@makaio/contracts';
import { defineDialectSchema, getTransactionQueryContext, resolveSchema } from '@makaio/storage-drizzle';
import { eq } from 'drizzle-orm';
import { workerAllocationScopeBinding as sqlite } from './storage/schema.js';
import { workerAllocationScopeBinding as postgres } from './storage/schema.postgres.js';

const schema = defineDialectSchema({ scopeBinding: sqlite }, { scopeBinding: postgres });
const INSTALLATION = 'installation';

/** Stored scope and confirmation metadata. */
export type AllocationScopeBinding = typeof sqlite.$inferSelect;

/**
 * Read the current installation's confirmation in the caller's transaction.
 * @param tx - Open host transaction.
 * @returns The binding, or undefined before confirmation.
 */
export async function readBinding(tx: HostTransaction): Promise<AllocationScopeBinding | undefined> {
  const query = getTransactionQueryContext(tx);
  const { scopeBinding } = resolveSchema(query, schema);
  const [binding] = await query.select().from(scopeBinding).where(eq(scopeBinding.installation, INSTALLATION));
  return binding;
}

/**
 * Insert the first confirmation and return the binding that won.
 * @param tx - Open host transaction.
 * @param value - Scope validated against the operator setting.
 * @param confirmedBy - Auditable caller and principal for the confirmation.
 * @returns The stored binding and whether this call inserted it.
 */
export async function writeBindingIfAbsent(
  tx: HostTransaction,
  value: string,
  confirmedBy: CallContextRecord,
): Promise<{ readonly binding: AllocationScopeBinding; readonly inserted: boolean }> {
  const query = getTransactionQueryContext(tx);
  const { scopeBinding } = resolveSchema(query, schema);
  const [inserted] = await query
    .insert(scopeBinding)
    .values({
      installation: INSTALLATION,
      allocationScope: value,
      confirmedAt: new Date().toISOString(),
      confirmedBy: JSON.stringify(confirmedBy),
    })
    .onConflictDoNothing({ target: scopeBinding.installation })
    .returning();
  if (inserted !== undefined) return { binding: inserted, inserted: true };
  const binding = await readBinding(tx);
  if (binding === undefined) throw new Error('Conflicting allocation scope binding could not be read');
  return { binding, inserted: false };
}
