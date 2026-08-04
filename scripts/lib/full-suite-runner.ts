/**
 * Shared full-suite test orchestration.
 *
 * A workspace's no-argument test run executes a plan of Vitest project
 * batches followed by an optional Bun surface. This module owns the plan
 * shapes and the run loop; workspace runners contribute only their project
 * tables and child-process execution.
 *
 * Two plan shapes exist:
 * - `single`: one all-project Vitest child. Every project interleaves on one
 *   worker pool, so serial lanes no longer act as sequential barriers. Vitest
 *   retains all project graphs until the child exits, so the child gets an
 *   explicit V8 old-space ceiling and the plan is gated on machine memory.
 * - `bounded`: small broad-project batches, then each execution-sensitive
 *   project in isolation. Bounds retained state for memory-constrained
 *   machines.
 *
 * Every batch runs inside the machine-wide test lock so concurrent test runs
 * from other checkouts interleave instead of oversubscribing the host.
 */
import { availableParallelism, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { isMachineTestLockEnabled, withMachineTestLock } from './machine-test-lock.js';

/** Minimum machine memory for the single-process plan. */
const SINGLE_PLAN_MEMORY_THRESHOLD_BYTES = 64 * 1024 ** 3;
/** V8 old-space ceiling for the single-process Vitest child, in MiB. */
const SINGLE_PLAN_HEAP_MB = 24_576;
/**
 * Extra workers beyond the core count for the single-process child.
 *
 * Subprocess- and IO-wait-heavy suites leave workers idle; a measured sweep
 * on a 16-core host found cores + 4 fastest (181s) versus the core count
 * (185s), the Vitest default (193s), and cores + 8 (195s, thrashing).
 */
const SINGLE_PLAN_WORKER_OVERSUBSCRIPTION = 4;

/** Execution plan shapes for the no-argument full-suite run. */
export type FullSuitePlanMode = 'single' | 'bounded';

/** Workspace-specific project tables consumed by the plan builder. */
export interface FullSuitePlanConfig {
  /** Broad shard project names, in execution order. */
  broadProjects: readonly string[];
  /** Maximum broad projects per bounded-mode batch. */
  broadBatchSize: number;
  /** Execution-sensitive projects that run isolated in bounded mode. */
  specialProjects: readonly string[];
  /**
   * Special project names declared by the workspace's Vitest configuration.
   * The plan refuses to run when the scheduled set drifts from this
   * declaration.
   */
  declaredSpecialProjects: readonly string[];
  /** Name of the trailing non-Vitest batch (e.g. the Bun surface), if any. */
  bunBatchName?: string;
}

/** Per-batch execution context passed to the workspace's batch executor. */
export interface FullSuiteBatchContext {
  /**
   * Explicit V8 old-space ceiling in MiB. Set only for the single-plan
   * all-project child; other batches keep the Node default.
   */
  heapMb?: number;
  /**
   * Explicit Vitest worker count. Set only for the single-plan all-project
   * child; other batches keep the Vitest default.
   */
  maxWorkers?: number;
}

/** Injectable boundaries for {@link runFullSuite}. */
export interface FullSuiteRunOptions {
  /** Workspace project tables. */
  config: FullSuitePlanConfig;
  /** Execute one batch of the plan in a child process. */
  executeBatch: (projects: readonly string[], context: FullSuiteBatchContext) => Promise<void>;
  /** Plan shape override; defaults to {@link resolvePlanMode}. */
  planMode?: FullSuitePlanMode;
  /** Environment for plan and lock decisions (default: `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Total machine memory in bytes (default: `os.totalmem()`). */
  totalMemoryBytes?: number;
  /** Monotonic clock in milliseconds. */
  now?: () => number;
  /** Progress sink. */
  log?: (message: string) => void;
  /** Failure summary sink. */
  reportFailure?: (message: string) => void;
  /** Serialize one batch against other test runs on the same machine. */
  acquireBatchSlot?: <T>(label: string, run: () => Promise<T>) => Promise<T>;
}

/**
 * Resolve which full-suite plan to run.
 *
 * `MAKAIO_TEST_PLAN` overrides; otherwise machines with enough memory for the
 * retained all-project state run the single-process plan.
 * @param env - Process environment to inspect.
 * @param totalMemoryBytes - Total machine memory in bytes.
 * @returns The plan mode to execute.
 */
export function resolvePlanMode(env: NodeJS.ProcessEnv, totalMemoryBytes: number): FullSuitePlanMode {
  if (env.MAKAIO_TEST_PLAN === 'single' || env.MAKAIO_TEST_PLAN === 'bounded') return env.MAKAIO_TEST_PLAN;
  return totalMemoryBytes >= SINGLE_PLAN_MEMORY_THRESHOLD_BYTES ? 'single' : 'bounded';
}

/**
 * Partition ordered projects into bounded batches.
 * @param projects - Ordered project names.
 * @param batchSize - Maximum projects retained by one Vitest process.
 * @returns Ordered project batches.
 */
export function buildProjectBatches(projects: readonly string[], batchSize: number): string[][] {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error(`Test project batch size must be a positive integer, received ${batchSize}`);
  }

  const batches: string[][] = [];
  for (let index = 0; index < projects.length; index += batchSize) {
    batches.push(projects.slice(index, index + batchSize));
  }
  return batches;
}

/**
 * Build the exact ordered process plan for the default test surface.
 * @param config - Workspace project tables.
 * @param mode - Plan shape: one all-project child, or bounded-memory batches.
 * @returns Ordered Vitest batches, followed by the Bun surface when declared.
 */
export function buildFullSuitePlan(config: FullSuitePlanConfig, mode: FullSuitePlanMode): string[][] {
  const declared = new Set(config.declaredSpecialProjects);
  const scheduled = new Set(config.specialProjects);
  if (
    scheduled.size !== config.specialProjects.length ||
    scheduled.size !== declared.size ||
    [...declared].some((project) => !scheduled.has(project))
  ) {
    throw new Error('Test scheduler special projects must match the declared Vitest special projects');
  }
  const bunBatches = config.bunBatchName ? [[config.bunBatchName]] : [];
  if (mode === 'single') {
    // Execution-sensitive projects join the all-project child rather than
    // running isolated; isolation that a project actually needs is expressed as
    // a Vitest group order inside this child instead of as a separate process.
    // Vitest refuses a group whose members resolve different worker budgets, so
    // a project sharing the default group order must either inherit the
    // run-wide budget or pin `maxWorkers: 1`, which Vitest routes into its own
    // sequential group before that check. A project needing any other budget
    // must declare its own group order, as the git lane does. This module only
    // receives project names, never the tables that define them, so the
    // requirement is asserted by whichever workspace owns those definitions.
    return [[...config.broadProjects, ...config.specialProjects], ...bunBatches];
  }
  return [
    ...buildProjectBatches(config.broadProjects, config.broadBatchSize),
    ...config.specialProjects.map((project) => [project]),
    ...bunBatches,
  ];
}

/**
 * Format an elapsed duration for concise runner diagnostics.
 * @param milliseconds - Elapsed wall-clock time in milliseconds.
 * @returns Human-readable duration with tenths-of-a-second precision.
 */
function formatDuration(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

/**
 * Run the canonical full-suite plan and return its exit status.
 *
 * Batches continue after failures so the full selected surface still reports
 * its independent failures; the final status is nonzero when any batch
 * failed.
 * @param options - Workspace configuration and injectable boundaries.
 * @returns Promise resolving to zero when every batch passed, otherwise one.
 */
export async function runFullSuite(options: FullSuiteRunOptions): Promise<number> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => performance.now());
  const log = options.log ?? ((message: string) => console.info(message));
  const reportFailure = options.reportFailure ?? ((message: string) => console.error(message));
  const acquireBatchSlot =
    options.acquireBatchSlot ??
    (<T>(label: string, run: () => Promise<T>) =>
      isMachineTestLockEnabled(env) ? withMachineTestLock(label, run, { log }) : run());

  const startedAt = now();
  const planMode = options.planMode ?? resolvePlanMode(env, options.totalMemoryBytes ?? totalmem());
  const plan = buildFullSuitePlan(options.config, planMode);
  log(`Test plan: ${planMode}`);

  const failedBatches: string[] = [];
  for (const projects of plan) {
    const isAllProjectsBatch = planMode === 'single' && projects.length > 1;
    const label = isAllProjectsBatch ? 'all projects' : projects.join(', ');
    const context: FullSuiteBatchContext = isAllProjectsBatch
      ? { heapMb: SINGLE_PLAN_HEAP_MB, maxWorkers: availableParallelism() + SINGLE_PLAN_WORKER_OVERSUBSCRIPTION }
      : {};
    const batchStartedAt = now();
    try {
      await acquireBatchSlot(label, () => options.executeBatch(projects, context));
    } catch (error) {
      // Test failures self-report through the child's inherited stdout, but
      // spawn- and lock-level failures (missing binary, ENOENT, unwritable lock
      // directory) produce no child output at all. Without this line such a
      // batch would be summarized as a bare label with no diagnostic.
      failedBatches.push(label);
      log(`Test project batch ${label} errored: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      log(`Test project batch ${label}: ${formatDuration(now() - batchStartedAt)}`);
    }
  }
  log(`Test suite wall clock: ${formatDuration(now() - startedAt)}`);
  if (failedBatches.length > 0) {
    reportFailure(`Test project batches failed: ${failedBatches.join('; ')}`);
    return 1;
  }
  return 0;
}

/**
 * Compose a `NODE_OPTIONS` value that applies a batch's V8 heap ceiling.
 * @param context - Batch execution context from {@link runFullSuite}.
 * @param existing - Existing `NODE_OPTIONS` value to preserve.
 * @returns The composed value, or undefined when the batch has no ceiling.
 */
export function heapNodeOptions(context: FullSuiteBatchContext, existing: string | undefined): string | undefined {
  if (!context.heapMb) return undefined;
  return `${existing ?? ''} --max-old-space-size=${context.heapMb}`.trim();
}
