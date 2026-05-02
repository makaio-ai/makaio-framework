/**
 * Mapping utilities between domain types and database row types.
 *
 * All JSON serialization/deserialization is centralized here to keep the
 * drizzle handler and registry free of ad-hoc JSON parse/stringify calls.
 * @packageDocumentation
 */

import type { SupervisorRuntime } from '../types.js';
import type { SelectSupervisorRuntime, InsertSupervisorRuntime } from './schema.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert an optional API field into a nullable database column value.
 * @param value - API value that may be undefined.
 * @returns Database-ready value using null for absence.
 */
function toNullable<T>(value: T | undefined): T | null {
  return value ?? null;
}

/**
 * Convert a nullable database column value into an optional API field.
 * @param value - Database value that may be null.
 * @returns API-friendly value using undefined for absence.
 */
function toOptional<T>(value: T | null): T | undefined {
  return value ?? undefined;
}

/**
 * Parse a nullable JSON string into a plain object of type `T`.
 *
 * Returns `undefined` when `json` is `null`, when the string is malformed,
 * or when the parsed value is not a non-array object.
 * @param json - Raw JSON string from a database column, or `null`.
 * @returns The parsed object, or `undefined` on any failure.
 */
function parseJsonObject<T extends Record<string, unknown>>(json: string | null): T | undefined {
  if (json === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as T;
    }
  } catch {
    // Malformed JSON — treat as absent
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Public mappers
// ---------------------------------------------------------------------------

/**
 * Map a {@link SupervisorRuntime} domain object to a database insert row.
 * @param runtime - Domain runtime object to persist.
 * @returns Row values ready for Drizzle insert or conflict-update.
 */
export function runtimeToRow(runtime: SupervisorRuntime): InsertSupervisorRuntime {
  return {
    supervisorSessionId: runtime.supervisorSessionId,
    clientId: runtime.clientId,
    pid: runtime.pid,
    status: runtime.status,
    cwd: runtime.cwd,
    command: runtime.command,
    argsJson: JSON.stringify(runtime.args),
    envJson: runtime.env !== undefined ? JSON.stringify(runtime.env) : null,
    sessionId: toNullable(runtime.sessionId),
    adapterSessionId: toNullable(runtime.adapterSessionId),
    startedAt: runtime.startedAt,
    stoppedAt: toNullable(runtime.stoppedAt),
    metadataJson: runtime.metadata !== undefined ? JSON.stringify(runtime.metadata) : null,
  };
}

/**
 * Map a database row back to a {@link SupervisorRuntime} domain object.
 *
 * JSON columns are parsed defensively — malformed blobs yield the safe
 * fallback (`[]` for args, `undefined` for env/metadata).
 * @param row - Raw database row from the `supervisor_runtimes` table.
 * @returns Hydrated domain runtime object.
 */
export function rowToRuntime(row: SelectSupervisorRuntime): SupervisorRuntime {
  let args: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.argsJson);
    if (Array.isArray(parsed) && parsed.every((el) => typeof el === 'string')) {
      args = parsed;
    }
  } catch {
    // Defensive fallback — malformed argsJson treated as empty list
  }

  const env = parseJsonObject<Record<string, string>>(row.envJson);
  const metadata = parseJsonObject<Record<string, unknown>>(row.metadataJson);

  return {
    supervisorSessionId: row.supervisorSessionId,
    clientId: row.clientId,
    pid: row.pid,
    status: row.status,
    cwd: row.cwd,
    command: row.command,
    args,
    env,
    sessionId: toOptional(row.sessionId),
    adapterSessionId: toOptional(row.adapterSessionId),
    startedAt: row.startedAt,
    stoppedAt: toOptional(row.stoppedAt),
    metadata,
  };
}
