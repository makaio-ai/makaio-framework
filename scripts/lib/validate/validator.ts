import chalk from 'chalk';
import { createSummary } from './util/summary-generator.js';
import { resolveFiles } from './util/file-resolver.js';
import { spawnWorker } from './workers/spawner.js';
import type { FileValidationResults, ValidateOptions, ValidationSummary, ToolRunStatus } from './types.js';
import type { WorkerConfig, WorkerInput, WorkerTool } from './workers/types.js';

const FULL_WORKSPACE_TYPESCRIPT_HEAP_MB = 6144;
const FULL_WORKSPACE_SEMANTIC_WORKER_TIMEOUT_MS = 1_200_000;
const DEFAULT_TOOLS: WorkerTool[] = ['prettier', 'eslint', 'stylelint', 'typescript'];

/**
 * Resolves worker configuration for the requested validation profile.
 * @param tool - Validation tool to run
 * @param options - Validation options
 * @returns Worker configuration with profile-specific resource limits
 */
export function getWorkerConfig(tool: WorkerTool, options: ValidateOptions): WorkerConfig {
  if (options.profile !== 'full-workspace') {
    return { tool };
  }

  if (tool === 'typescript') {
    return {
      tool,
      maxHeapMB: FULL_WORKSPACE_TYPESCRIPT_HEAP_MB,
      timeoutMs: FULL_WORKSPACE_SEMANTIC_WORKER_TIMEOUT_MS,
    };
  }

  if (tool === 'eslint') {
    return { tool, timeoutMs: FULL_WORKSPACE_SEMANTIC_WORKER_TIMEOUT_MS };
  }

  return { tool };
}

/**
 * Resolves the validation tools requested for a run.
 * @param options - Validation options
 * @returns Ordered validation tools to run
 */
export function resolveWorkerTools(options: ValidateOptions): WorkerTool[] {
  if (options.tools === undefined) {
    return [...DEFAULT_TOOLS];
  }

  if (options.tools.length === 0) {
    throw new Error('tools must not be empty');
  }

  return options.tools;
}

/**
 * Workspace validator for TypeScript, ESLint, Prettier, and Stylelint.
 *
 * Each validator runs in its own forked process with isolated V8 heap memory.
 * When a worker process exits, ALL its memory is immediately reclaimed by the OS.
 * This prevents OOM errors that occur when running all validators in a single process.
 * @example
 * ```typescript
 * const validator = new WorkspaceValidator();
 * const summary = await validator.validate({
 *   files: ['src/index.ts'],
 *   fix: true
 * });
 * console.log(`Validated ${summary.totalFiles} files`);
 * ```
 */
export class WorkspaceValidator {
  private fileResults: FileValidationResults = {};

  /**
   * Validates files using Prettier, ESLint, Stylelint, and TypeScript.
   *
   * Each validator runs in an isolated worker process with its own memory.
   * Workers run in parallel for performance, but memory is isolated.
   * @param options - Validation options
   * @returns Promise resolving to validation summary with results and stats
   */
  public async validate(options: ValidateOptions = {}): Promise<ValidationSummary> {
    const files = await resolveFiles(options);

    if (files.length === 0) {
      console.warn(chalk.yellow('No files found matching the pattern'));
      return createSummary(this.fileResults, [], 0);
    }

    const workerInput: WorkerInput = {
      files,
      options: {
        fix: options.fix,
        cache: options.cache,
        verbose: options.verbose,
        tsConfigFile: options.tsConfigFile,
        profile: options.profile,
      },
    };

    // Spawn all workers in parallel - each has isolated memory
    const tools = resolveWorkerTools(options);

    const workerPromises = tools.map((tool) =>
      spawnWorker(getWorkerConfig(tool, options), workerInput).catch((error) => ({
        success: false,
        results: {} as FileValidationResults,
        status: {
          tool,
          status: 'failed' as const,
          error: error instanceof Error ? error.message : String(error),
        },
        error: error instanceof Error ? error.message : String(error),
      })),
    );

    const workerOutputs = await Promise.all(workerPromises);

    // Merge results from all workers
    const toolStatuses: ToolRunStatus[] = [];

    for (const output of workerOutputs) {
      // Merge file results
      for (const [file, results] of Object.entries(output.results)) {
        if (!this.fileResults[file]) {
          this.fileResults[file] = [];
        }
        this.fileResults[file].push(...results);
      }

      // Collect tool status
      toolStatuses.push(output.status);
    }

    const summary = createSummary(this.fileResults, toolStatuses, files.length);
    summary.processedFiles = files;
    return summary;
  }
}
