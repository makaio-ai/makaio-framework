import { defineDialectSchema } from '@makaio/storage-drizzle';
import { sessions, agents, adapterSessionClaims } from './schema.js';
import {
  sessions as sessionsPg,
  agents as agentsPg,
  adapterSessionClaims as adapterSessionClaimsPg,
} from './schema.postgres.js';

/** Dialect variants for the session storage tables. */
export const sessionStorageSchema = defineDialectSchema(
  { sessions, agents, adapterSessionClaims },
  { sessions: sessionsPg, agents: agentsPg, adapterSessionClaims: adapterSessionClaimsPg },
);
