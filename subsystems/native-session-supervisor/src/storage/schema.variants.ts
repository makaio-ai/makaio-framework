import { defineDialectSchema } from '@makaio/storage-drizzle';
import { supervisorRuntimes } from './schema.js';
import { supervisorRuntimes as supervisorRuntimesPg } from './schema.postgres.js';

/** Dialect variants for the supervisor runtime storage tables. */
export const supervisorRuntimesSchema = defineDialectSchema(
  { supervisorRuntimes },
  { supervisorRuntimes: supervisorRuntimesPg },
);
