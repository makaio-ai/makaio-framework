/**
 * Postgres face of the supervisor runtimes table.
 *
 * Derived from the dual definition in `schema.ts`; the Postgres-discovered
 * barrel exposes the Postgres table object under the canonical name. Row types
 * are owned exclusively by `schema.ts`.
 */
import { supervisorRuntimesDual } from './schema.js';

/** Postgres face of the `supervisor_runtimes` table. */
export const supervisorRuntimes = supervisorRuntimesDual.postgres;
