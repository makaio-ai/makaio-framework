import { join } from 'node:path';

/** Worker entry build mode. */
export type WorkflowWorkerEntryMode = 'source' | 'dist';

/**
 * Options for resolving the workflow worker entrypoint file path.
 *
 * `moduleDir` is the directory that contains the currently-running boot module
 * (i.e. `path.dirname(fileURLToPath(import.meta.url))` at the call site).
 * The worker entry is always a sibling `workflow-worker/` subdirectory of
 * `moduleDir`, so this one value covers all three package layouts:
 *
 * - source     `moduleDir = <repo>/runtimes/node/src`
 *              → `<repo>/runtimes/node/src/workflow-worker/worker-entry.ts`
 * - standalone `moduleDir = <pkg>/dist`
 *              → `<pkg>/dist/workflow-worker/worker-entry.mjs`
 * - umbrella   `moduleDir = <pkg>/dist/runtime-node`
 *              → `<pkg>/dist/runtime-node/workflow-worker/worker-entry.mjs`
 *
 * Using the former `packageRoot` shape would produce a double-`dist` path
 * (`<pkg>/dist/dist/…`) in the umbrella layout.
 */
export interface WorkflowWorkerEntryResolverOptions {
  /**
   * Absolute path to the directory that contains the running boot module.
   * Typically `path.dirname(fileURLToPath(import.meta.url))`.
   */
  readonly moduleDir: string;
  /** Whether to resolve the source TypeScript entry or the built distribution entry. */
  readonly mode: WorkflowWorkerEntryMode;
}

/**
 * Resolve the absolute file path to the workflow worker entrypoint.
 *
 * The worker entry is always located at
 * `<moduleDir>/workflow-worker/worker-entry.(ts|mjs)` — a sibling
 * subdirectory of the running boot module — regardless of which of the three
 * supported package layouts is active (source, standalone dist, umbrella dist).
 *
 * In `source` mode, returns the TypeScript source path used during development
 * (requires a loader like `tsx` or `ts-node` for direct execution).
 * In `dist` mode, returns the compiled ESM bundle path used in production.
 * @param options - Resolution options with the running module directory and mode.
 * @returns Absolute path to the workflow worker entrypoint file.
 */
export function resolveWorkflowWorkerEntry(options: WorkflowWorkerEntryResolverOptions): string {
  if (options.mode === 'source') {
    return join(options.moduleDir, 'workflow-worker', 'worker-entry.ts');
  }

  return join(options.moduleDir, 'workflow-worker', 'worker-entry.mjs');
}
