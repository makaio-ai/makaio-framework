import { join } from 'node:path';

/**
 * Options for resolving the worker entrypoint file path.
 */
export interface WorkerEntryResolverOptions {
  /** Absolute path to the package root directory. */
  readonly packageRoot: string;
  /** Whether to resolve the source TypeScript entry or the built distribution entry. */
  readonly mode: 'source' | 'dist';
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
