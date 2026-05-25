import { join } from 'node:path';

/** Worker entry build mode. */
export type WorkflowWorkerEntryMode = 'source' | 'dist';

/**
 * Options for resolving the workflow worker entrypoint file path.
 */
export interface WorkflowWorkerEntryResolverOptions {
  /** Absolute path to the package root directory. */
  readonly packageRoot: string;
  /** Whether to resolve the source TypeScript entry or the built distribution entry. */
  readonly mode: WorkflowWorkerEntryMode;
}

/**
 * Resolve the absolute file path to the workflow worker entrypoint.
 *
 * In `source` mode, returns the TypeScript source path used during development
 * (requires a loader like `tsx` or `ts-node` for direct execution).
 * In `dist` mode, returns the compiled ESM bundle path used in production.
 * @param options - Resolution options with package root and mode.
 * @returns Absolute path to the workflow worker entrypoint file.
 */
export function resolveWorkflowWorkerEntry(options: WorkflowWorkerEntryResolverOptions): string {
  if (options.mode === 'source') {
    return join(options.packageRoot, 'src', 'workflow-worker', 'worker-entry.ts');
  }

  return join(options.packageRoot, 'dist', 'workflow-worker', 'worker-entry.mjs');
}
