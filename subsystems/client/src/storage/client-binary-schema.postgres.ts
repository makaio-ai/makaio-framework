/**
 * Postgres faces of the client binary installation state tables.
 *
 * Derived from the dual definitions in `client-binary-schema.ts`; the
 * Postgres-discovered barrel exposes the Postgres table objects under the
 * canonical names. Row types are owned exclusively by `client-binary-schema.ts`.
 * @packageDocumentation
 */
import { clientBinaryVersionsDual, clientBinaryStateDual } from './client-binary-schema.js';

/** Postgres face of the `client_binary_versions` table. */
export const clientBinaryVersions = clientBinaryVersionsDual.postgres;

/** Postgres face of the `client_binary_state` table. */
export const clientBinaryState = clientBinaryStateDual.postgres;
