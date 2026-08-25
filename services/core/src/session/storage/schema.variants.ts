import { defineDialectSchema } from '@makaio/storage-drizzle';
import {
  sessions,
  agents,
  runtimeInstanceIncarnationCounters,
  runtimeInstances,
  adapterSessionClaims,
} from './schema.js';
import {
  sessions as sessionsPg,
  agents as agentsPg,
  runtimeInstanceIncarnationCounters as runtimeInstanceIncarnationCountersPg,
  runtimeInstances as runtimeInstancesPg,
  adapterSessionClaims as adapterSessionClaimsPg,
} from './schema.postgres.js';

/** Dialect variants for the session storage tables. */
export const sessionStorageSchema = defineDialectSchema(
  { sessions, agents, runtimeInstanceIncarnationCounters, runtimeInstances, adapterSessionClaims },
  {
    sessions: sessionsPg,
    agents: agentsPg,
    runtimeInstanceIncarnationCounters: runtimeInstanceIncarnationCountersPg,
    runtimeInstances: runtimeInstancesPg,
    adapterSessionClaims: adapterSessionClaimsPg,
  },
);
