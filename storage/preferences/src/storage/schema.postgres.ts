/**
 * Postgres face of the preferences table.
 *
 * Derived from the dual definition in `schema.ts`; the Postgres-discovered
 * barrel exposes the Postgres table object under the canonical name. Row types
 * are owned exclusively by `schema.ts`.
 */
import { preferencesDual } from './schema.js';

/** Postgres face of the `preferences` table. */
export const preferences = preferencesDual.postgres;
