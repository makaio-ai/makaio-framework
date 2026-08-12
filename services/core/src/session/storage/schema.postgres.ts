/**
 * Postgres faces for session storage tables.
 *
 * The tables are defined once via `defineDualTable` in `schema.ts`; this file
 * exposes their Postgres faces under the canonical names so the Postgres
 * migration chain and the dialect-variant aggregate keep resolving them.
 */
import {
  sessionsDual,
  agentsDual,
  runtimeInstanceIncarnationCountersDual,
  runtimeInstancesDual,
  adapterSessionClaimsDual,
} from './schema.js';

/** Postgres face of the `sessions` table. */
export const sessions = sessionsDual.postgres;

/** Postgres face of the `agents` table. */
export const agents = agentsDual.postgres;

/** Postgres face of the private runtime-incarnation counter table. */
export const runtimeInstanceIncarnationCounters = runtimeInstanceIncarnationCountersDual.postgres;

/** Postgres face of the `runtime_instances` table. */
export const runtimeInstances = runtimeInstancesDual.postgres;

/** Postgres face of the `adapter_session_claims` table. */
export const adapterSessionClaims = adapterSessionClaimsDual.postgres;
