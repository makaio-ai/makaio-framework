import { defineDialectSchema } from '@makaio/storage-drizzle';
import { importCursors } from './schema.js';
import { importCursors as importCursorsPg } from './schema.postgres.js';

/** Dialect variants for the import cursors table. */
export const importCursorsSchema = defineDialectSchema({ importCursors }, { importCursors: importCursorsPg });
