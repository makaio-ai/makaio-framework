/**
 * Postgres face of the log import settings table.
 *
 * Derived from the dual definition in `schema.ts`; the Postgres-discovered
 * barrel exposes the Postgres table object under the canonical name. Row types
 * are owned exclusively by `schema.ts`.
 */
import { logImportSettingsDual } from './schema.js';

/** Postgres face of the `log_import_settings` table. */
export const logImportSettings = logImportSettingsDual.postgres;
