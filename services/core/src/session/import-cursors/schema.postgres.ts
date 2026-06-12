/**
 * Postgres face for the import cursors table.
 *
 * The table is defined once via `defineDualTable` in `schema.ts`; this file
 * exposes its Postgres face under the canonical name so the Postgres migration
 * chain and the dialect-variant aggregate keep resolving it.
 */
import { importCursorsDual } from './schema.js';

/** Postgres face of the `import_cursors` table. */
export const importCursors = importCursorsDual.postgres;
