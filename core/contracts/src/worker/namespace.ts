import { createBusNamespace } from '@makaio/core';
import { WorkerSchemas } from './schemas.js';

/** Well-known restricted transport identity used for worker bootstrap claims. */
export const WORKER_BOOTSTRAP_IDENTITY_ID = 'worker-bootstrap';

/**
 * Worker bus namespace definition.
 *
 * Register at boot time via `bus.registerNamespace(WorkerNamespace)` or
 * include in the `FrameworkContractNamespaces` catalog.
 */
export const WorkerNamespace = createBusNamespace('worker', WorkerSchemas);

/**
 * Typed subject tokens for the `worker` bus namespace.
 *
 * Use these tokens in `bus.on()`, `bus.emit()`, and `bus.request()` calls
 * instead of raw subject strings to get schema validation and type inference.
 * @example
 * ```typescript
 * bus.on(WorkerSubjects.lifecycle.ready, (payload) => {
 *   console.log('worker ready', payload.executionAttemptId);
 * });
 * ```
 */
export const WorkerSubjects = WorkerNamespace.subjects;
