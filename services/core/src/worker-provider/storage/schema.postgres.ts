import { workerAllocationScopeBindingDual, workerDispatchDual } from './schema.js';

/** Postgres schema for the scope binding. */
export const workerAllocationScopeBinding = workerAllocationScopeBindingDual.postgres;

/** Postgres face of the dispatch claim table. */
export const workerDispatch = workerDispatchDual.postgres;
