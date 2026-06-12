import { defineDialectSchema } from '@makaio/storage-drizzle';
import { turns } from './schema.js';
import { turns as turnsPg } from './schema.postgres.js';

/** Dialect variants for the turns table. */
export const turnsSchema = defineDialectSchema({ turns }, { turns: turnsPg });
