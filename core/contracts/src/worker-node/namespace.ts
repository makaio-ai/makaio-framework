import { createBusNamespace } from '@makaio/core';
import { WorkerNodeSchemas } from './schemas.js';

/** Well-known restricted transport identity used for worker bootstrap claims. */
export const WORKER_BOOTSTRAP_IDENTITY_ID = 'worker-bootstrap';

/**
 * WorkerNode bus namespace definition.
 *
 * Register at boot time via `bus.registerNamespace(WorkerNodeNamespace)` or
 * include in the `FrameworkContractNamespaces` catalog.
 */
export const WorkerNodeNamespace = createBusNamespace('worker-node', WorkerNodeSchemas);

/**
 * Typed subject tokens for the `worker-node` bus namespace.
 *
 * Use these tokens in `bus.on()`, `bus.emit()`, and `bus.request()` calls
 * instead of raw subject strings to get schema validation and type inference.
 * @example
 * ```typescript
 * bus.on(WorkerNodeSubjects.lifecycle.ready, (payload) => {
 *   console.log('node ready', payload.executionAttemptId);
 * });
 * ```
 */
export const WorkerNodeSubjects = WorkerNodeNamespace.subjects;
