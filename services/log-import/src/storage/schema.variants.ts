import { defineDialectSchema } from '@makaio/storage-drizzle';
import { logImportSettings } from './schema.js';
import { logImportSettings as logImportSettingsPg } from './schema.postgres.js';

/** Dialect variants for the log import settings tables. */
export const logImportSettingsSchema = defineDialectSchema(
  { logImportSettings },
  { logImportSettings: logImportSettingsPg },
);
