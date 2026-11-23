import { ne, type Column, type SQL } from 'drizzle-orm';

const retainedGateNodeType = 'gate';

/**
 * Excludes retained gate rows from a narrow response query.
 * @param column - Stored node or step type column.
 * @returns A predicate for rows that can appear in the response.
 */
export function excludeRetainedGateRows(column: Column): SQL {
  return ne(column, retainedGateNodeType);
}

/**
 * Checks whether a stored node type belongs to a retained gate row.
 * @param value - Stored node type.
 * @returns Whether the row represents a retained gate.
 */
export function isRetainedGateNodeType(value: string): boolean {
  return value === retainedGateNodeType;
}
