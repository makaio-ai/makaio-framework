/**
 * Postgres face of the harness definitions table.
 *
 * Derived from the dual definition in `schema.ts`; the Postgres-discovered
 * barrel exposes the Postgres table object under the canonical name. Row types
 * are owned exclusively by `schema.ts`.
 */
import { harnessDefinitionsDual } from './schema.js';

/** Postgres face of the `harness_definitions` table. */
export const harnessDefinitions = harnessDefinitionsDual.postgres;
