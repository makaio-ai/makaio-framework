/**
 * Postgres face of the `client_profiles` table.
 *
 * Derived from the dual definition in `profile-schema.ts`; the
 * Postgres-discovered barrel exposes the Postgres table object under the
 * canonical name. Row types are owned exclusively by `profile-schema.ts`.
 * @packageDocumentation
 */
import { clientProfilesDual } from './profile-schema.js';

/** Postgres face of the `client_profiles` table. */
export const clientProfiles = clientProfilesDual.postgres;
