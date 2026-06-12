import { defineDialectSchema } from '@makaio/storage-drizzle';
import { harnessDefinitions } from './schema.js';
import { harnessDefinitions as harnessDefinitionsPg } from './schema.postgres.js';

/** Dialect variants for the harness definitions table. */
export const harnessStorageSchema = defineDialectSchema(
  { harnessDefinitions },
  { harnessDefinitions: harnessDefinitionsPg },
);
