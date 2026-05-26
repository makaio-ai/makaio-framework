import { join } from 'node:path';

/** Worker entry build mode. */
export type WorkerEntryMode = 'source' | 'dist';

/**
 * Options for resolving the worker entrypoint file path.
 */
export interface WorkerEntryResolverOptions {
  /** Absolute path to the package root directory. */
  readonly packageRoot: string;
  /** Whether to resolve the source TypeScript entry or the built distribution entry. */
  readonly mode: WorkerEntryMode;
}

/**
 * Resolve the absolute file path to the worker entrypoint.
 *
 * In `source` mode, returns the TypeScript source path used during development
 * (requires a loader like `tsx` or `ts-node` for direct execution).
 * In `dist` mode, returns the compiled ESM bundle path used in production.
 * @param options - Resolution options with package root and mode.
 * @returns Absolute path to the worker entrypoint file.
 */
export function resolveWorkerEntry(options: WorkerEntryResolverOptions): string {
  if (options.mode === 'source') {
    return join(options.packageRoot, 'src', 'workflow-step-runner', 'worker-entry.ts');
  }

  return join(options.packageRoot, 'dist', 'workflow-step-runner', 'worker-entry.mjs');
}

/**
 * Build Node argv for a worker entry.
 *
 * TypeScript source entries require the `tsx` import hook in development.
 * Compiled `.mjs` entries are already executable by Node and must not load
 * `tsx`, which is not part of production dist runtime assumptions.
 * @param workerEntry - Absolute path to the worker entrypoint.
 * @returns argv tail to pass after the `node` executable.
 */
export function buildNodeWorkerEntryArgs(workerEntry: string): string[] {
  return workerEntry.endsWith('.ts') || workerEntry.endsWith('.tsx') ? ['--import', 'tsx', workerEntry] : [workerEntry];
}
