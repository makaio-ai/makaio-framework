/**
 * Postgres faces of the tables declared in `./retained-tables.ts` for the same migration generator exception.
 */
import { workflowGateInstancesDual, worklogGateEventsDual } from './retained-tables.js';

/** Postgres face of the `workflow_gate_instances` table. */
export const workflowGateInstances = workflowGateInstancesDual.postgres;

/** Postgres face of the `worklog_gate_events` table. */
export const worklogGateEvents = worklogGateEventsDual.postgres;
