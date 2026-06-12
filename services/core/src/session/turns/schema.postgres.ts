/**
 * Postgres face for the turns table.
 *
 * The table is defined once via `defineDualTable` in `schema.ts`; this file
 * exposes its Postgres face under the canonical name so the Postgres migration
 * chain and the dialect-variant aggregate keep resolving it.
 */
import { turnsDual } from './schema.js';

/** Postgres face of the `turns` table. */
export const turns = turnsDual.postgres;
