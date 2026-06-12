/**
 * Dialect variants for the preferences storage table.
 *
 * Provides both SQLite and Postgres table objects under the same typed
 * interface so callers can resolve the correct dialect at runtime via
 * `resolveSchema`.
 */

import { defineDialectSchema } from '@makaio/storage-drizzle';
import { preferences } from './schema.js';
import { preferences as preferencesPg } from './schema.postgres.js';

/** Dialect variants for the preferences storage table. */
export const preferencesSchema = defineDialectSchema({ preferences }, { preferences: preferencesPg });
