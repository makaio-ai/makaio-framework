import { createBusNamespace } from '@makaio/core';
import { ExecutionAttemptSchemas } from './schemas.js';

/**
 * ExecutionAttempt bus namespace definition.
 *
 * One static namespace carrying ExecutionAttempt subjects. There is no
 * per-attempt namespace factory: attempt scoping is a payload filter
 * (`bus.withFilter({ executionAttemptId })`), not a namespace dimension.
 *
 * Register at boot time via `bus.registerNamespace(ExecutionAttemptNamespace)` or
 * include in the `FrameworkContractNamespaces` catalog.
 */
export const ExecutionAttemptNamespace = createBusNamespace('execution-attempt', ExecutionAttemptSchemas);

/**
 * Typed subject tokens for the `execution-attempt` bus namespace.
 *
 * Use these tokens in `bus.on()`, `bus.emit()`, and `bus.request()` calls instead
 * of raw subject strings to get schema validation and type inference. Dotted
 * schema keys nest under `bootstrap`, `runtime`, `operation`, `instruction`, and `outcome`.
 * @example
 * ```typescript
 * bus.on(ExecutionAttemptSubjects.runtime.ready, (ctx) => {
 *   console.log('runtime ready', ctx.payload.executionAttemptId);
 * });
 * ```
 */
export const ExecutionAttemptSubjects = ExecutionAttemptNamespace.subjects;
