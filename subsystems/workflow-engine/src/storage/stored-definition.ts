import { sql } from 'drizzle-orm';
import type { AnyColumn, SQL } from 'drizzle-orm';
import type { RejectedWorkflowDefinition, WorkflowDefinition } from '@makaio/contracts';
import { WorkflowDefinitionSchema } from '@makaio/contracts';
import type { z } from 'zod';
import { workflowEngineSchema } from './schema.variants.js';
import { fromScopeColumns } from './scope-helpers.js';

/** SQLite face of the `workflow_definitions` table, shared by every reader and writer of stored rows. */
export type WorkflowDefinitionsTable = typeof workflowEngineSchema.sqlite.workflowDefinitions;

/** A `workflow_definitions` row exactly as the driver maps it (JSON columns decoded). */
export type DbDefinitionRow = WorkflowDefinitionsTable['$inferSelect'];

/** The twelve JSON columns of `workflow_definitions`; readers select them as undecoded text. */
type StoredJsonColumnKey =
  | 'root'
  | 'inputSchema'
  | 'configSchema'
  | 'outputSchema'
  | 'state'
  | 'artifact'
  | 'triggers'
  | 'canvasLayout'
  | 'extensions'
  | 'source'
  | 'executableSource'
  | 'requirements';

const STORED_JSON_COLUMN_KEYS: readonly StoredJsonColumnKey[] = [
  'root',
  'inputSchema',
  'configSchema',
  'outputSchema',
  'state',
  'artifact',
  'triggers',
  'canvasLayout',
  'extensions',
  'source',
  'executableSource',
  'requirements',
];

/** A `workflow_definitions` row as the readers select it: JSON columns as stored text. */
export type StoredDefinitionRow = Omit<DbDefinitionRow, StoredJsonColumnKey> &
  Record<StoredJsonColumnKey, string | null>;

/**
 * Selection fragment for the stored text of a JSON column; the driver mapping does not decode it.
 * @param column - JSON column of the table.
 * @returns A `sql<string \| null>` fragment for `CAST(column AS TEXT)`.
 */
export function storedJsonText(column: AnyColumn): SQL<string | null> {
  return sql<string | null>`CAST(${column} AS TEXT)`;
}

/**
 * Decode one stored JSON text. SQL NULL decodes to `undefined`; text that is not valid JSON is a failure, not a throw.
 * @param text - Stored text of a JSON column, or null.
 * @returns The decoded value, or a failure.
 */
export function decodeStoredJson(
  text: string | null,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  if (text === null) {
    return { ok: true, value: undefined };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Selection for `db.select(...)`: every column unchanged, the twelve JSON columns as {@link storedJsonText}.
 * @param columns - Columns of `workflow_definitions` (`getTableColumns`).
 * @returns Field map whose result type is {@link StoredDefinitionRow}.
 */
export function storedDefinitionSelection(columns: WorkflowDefinitionsTable['_']['columns']) {
  return {
    ...columns,
    root: storedJsonText(columns.root),
    inputSchema: storedJsonText(columns.inputSchema),
    configSchema: storedJsonText(columns.configSchema),
    outputSchema: storedJsonText(columns.outputSchema),
    state: storedJsonText(columns.state),
    artifact: storedJsonText(columns.artifact),
    triggers: storedJsonText(columns.triggers),
    canvasLayout: storedJsonText(columns.canvasLayout),
    extensions: storedJsonText(columns.extensions),
    source: storedJsonText(columns.source),
    executableSource: storedJsonText(columns.executableSource),
    requirements: storedJsonText(columns.requirements),
  };
}

/**
 * Formats the issues of a failed {@link WorkflowDefinitionSchema} parse as `<path>: <message>` entries joined by
 * `; `, matching the reason convention used for stored run contexts. Shared by both the stored-row re-check in this
 * module and the incoming-payload check in `definition-handler.ts`.
 * @param error - Zod error from a failed schema parse.
 * @returns The joined, human-readable reason.
 */
export function describeWorkflowDefinitionIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/**
 * Rebuild and check one stored workflow definition row.
 * A JSON column that cannot be decoded, a row-mapping failure (for example an incomplete scope) and a schema failure
 * all become the `reason`; the row owns its identity, so there is no second parameter.
 * @param row - Row of `workflow_definitions` selected with {@link storedDefinitionSelection}.
 * @returns The readable definition, or the rejection naming the row and why.
 */
export function readStoredDefinition(
  row: StoredDefinitionRow,
): { readonly definition: WorkflowDefinition } | { readonly rejected: RejectedWorkflowDefinition } {
  const decodedValues: Partial<Record<StoredJsonColumnKey, unknown>> = {};
  const decodeFailures: string[] = [];
  for (const key of STORED_JSON_COLUMN_KEYS) {
    const decoded = decodeStoredJson(row[key]);
    if (!decoded.ok) {
      decodeFailures.push(`${key}: stored value is not valid JSON`);
      continue;
    }
    decodedValues[key] = decoded.value;
  }
  if (decodeFailures.length > 0) {
    return { rejected: { id: row.id, reason: decodeFailures.join('; ') } };
  }

  let scope: ReturnType<typeof fromScopeColumns>;
  try {
    scope = fromScopeColumns(row);
  } catch (error) {
    return { rejected: { id: row.id, reason: error instanceof Error ? error.message : String(error) } };
  }

  const candidate = {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    root: decodedValues.root,
    inputSchema: decodedValues.inputSchema,
    configSchema: decodedValues.configSchema,
    outputSchema: decodedValues.outputSchema,
    state: decodedValues.state,
    artifact: decodedValues.artifact,
    triggers: decodedValues.triggers,
    scope,
    canvasLayout: decodedValues.canvasLayout,
    extensions: decodedValues.extensions,
    source: decodedValues.source,
    executableSource: decodedValues.executableSource,
    requirements: decodedValues.requirements,
    successFinalizerId: row.successFinalizerId ?? undefined,
  };

  const result = WorkflowDefinitionSchema.safeParse(candidate);
  if (!result.success) {
    return { rejected: { id: row.id, reason: describeWorkflowDefinitionIssues(result.error) } };
  }
  return { definition: result.data };
}
