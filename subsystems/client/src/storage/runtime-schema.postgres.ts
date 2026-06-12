/**
 * Postgres face of the `client_runtimes` table.
 *
 * Derived from the dual definition in `runtime-schema.ts`; the
 * Postgres-discovered barrel exposes the Postgres table object under the
 * canonical name. Row types are owned exclusively by `runtime-schema.ts`.
 * @packageDocumentation
 */
import { clientRuntimesDual } from './runtime-schema.js';

/** Postgres face of the `client_runtimes` table. */
export const clientRuntimes = clientRuntimesDual.postgres;
