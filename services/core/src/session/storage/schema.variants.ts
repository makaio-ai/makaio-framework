import { defineDialectSchema } from '@makaio/storage-drizzle';
import { sessions, agents } from './schema.js';
import { sessions as sessionsPg, agents as agentsPg } from './schema.postgres.js';

/** Dialect variants for the session storage tables. */
export const sessionStorageSchema = defineDialectSchema(
  { sessions, agents },
  { sessions: sessionsPg, agents: agentsPg },
);
