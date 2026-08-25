import { type CodeExecutionRequest, type JsonValue } from '@makaio/contracts';
import type Piscina from 'piscina';
import type { CodeExecutionWorkerTask } from './types.js';

/** One lazily resolved, provider-owned runtime configuration snapshot. */
export interface RuntimeConfiguration {
  /** Canonical package targets materialized for every later invocation. */
  readonly packageRoots: ReadonlyMap<string, string>;
  /** Diagnostics redactions derived from those same package targets. */
  readonly redactions: readonly string[];
}

/** Detached invocation fields after JSON argument admission. */
export interface AdmittedInvocationInput {
  /** Validated program definition. */
  readonly program: CodeExecutionRequest['program'];
  /** JSON-safe argument passed to the worker. */
  readonly arguments: JsonValue;
}

/** One pool task and the generation whose lifecycle owns it. */
export interface PoolSubmission<Generation> {
  /** Generation that accepted the task. */
  readonly generation: Generation;
  /** Settles when Piscina answered, aborted, or failed the task. */
  readonly running: Promise<unknown>;
}

/**
 * One worker pool and the lifecycle accounting that governs its retirement.
 *
 * Each generation serves a bounded number of invocations because imported
 * module graphs remain in a worker's module map. Its named phases are:
 *
 * - **active**: accepts work and increments `submitted`.
 * - **retired**: accepts no more work while `outstanding` falls.
 * - **drained**: tears down once `outstanding` reaches zero.
 *
 * This is the single lifecycle definition imported by the provider.
 */
export interface WorkerGeneration {
  /** Worker pool this generation owns. */
  readonly pool: Piscina<CodeExecutionWorkerTask, unknown>;
  /** Invocations handed to this generation, ever. */
  submitted: number;
  /** Invocations it has been handed and has not answered yet. */
  outstanding: number;
  /** Whether it has been detached and is only finishing accepted work. */
  retired: boolean;
  /** Whether a pool fault has already detached this generation. */
  failed: boolean;
  /** Memoized teardown, whose rejection remains observable to disposal. */
  teardown?: Promise<void>;
}
