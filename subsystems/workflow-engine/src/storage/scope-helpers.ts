import { eq } from 'drizzle-orm';
import type { Column } from 'drizzle-orm';
import type { WorkflowExecutionScope } from '@makaio/contracts';

// ─────────────────────────────────────────────────────────────
// Scope column helpers (shared by definition, execution, and run-context tables)
// ─────────────────────────────────────────────────────────────

/** Flat scope column values for DB insert/update and predicate building. */
export interface ScopeColumns {
  scopeType: WorkflowExecutionScope['type'];
  scopeKind: string;
  scopeId: string;
}

/**
 * Decompose a {@link WorkflowExecutionScope} into flat DB columns.
 * @param scope - Scope discriminated union to flatten.
 * @returns Flat column values for `scopeType`, `scopeKind`, `scopeId`.
 */
export function toScopeColumns(scope: WorkflowExecutionScope): ScopeColumns {
  if (scope.type === 'global') {
    return { scopeType: 'global', scopeKind: '', scopeId: '' };
  }
  if (scope.type === 'external') {
    return { scopeType: 'external', scopeKind: scope.kind, scopeId: scope.id };
  }
  // workspace | session — id required, kind not applicable
  return { scopeType: scope.type, scopeKind: '', scopeId: scope.id };
}

/**
 * Reconstruct a {@link WorkflowExecutionScope} from flat DB columns.
 * @param row - Row fragment with scope columns.
 * @returns Reconstructed scope discriminated union.
 * @throws Error when required columns are missing for the declared type.
 */
export function fromScopeColumns(row: ScopeColumns): WorkflowExecutionScope {
  switch (row.scopeType) {
    case 'global':
      return { type: 'global' };
    case 'external':
      if (!row.scopeKind || !row.scopeId) {
        throw new Error('Invalid external workflow scope row: scopeKind and scopeId are required');
      }
      return { type: 'external', kind: row.scopeKind, id: row.scopeId };
    case 'workspace':
    case 'session':
      if (!row.scopeId) {
        throw new Error(`Invalid ${row.scopeType} workflow scope row: scopeId is required`);
      }
      return { type: row.scopeType, id: row.scopeId };
    default: {
      const _exhaustive: never = row.scopeType;
      throw new Error(`Unknown scope type: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Build Drizzle equality predicates for the three scope columns on any table
 * that declares `scopeType`, `scopeKind`, and `scopeId` columns.
 *
 * Shared by `definition-handler.ts`, `handler.ts`, and any future handler that
 * needs to filter rows by execution scope.
 * @param table - Table reference with the three scope columns.
 * @param scope - Scope to match against.
 * @returns Array of three equality predicates for use with Drizzle `and()`.
 */
export function buildScopePredicates(
  table: { scopeType: Column; scopeKind: Column; scopeId: Column },
  scope: WorkflowExecutionScope,
) {
  const { scopeType, scopeKind, scopeId } = toScopeColumns(scope);
  return [eq(table.scopeType, scopeType), eq(table.scopeKind, scopeKind), eq(table.scopeId, scopeId)];
}
