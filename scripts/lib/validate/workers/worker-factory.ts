/**
 * Factory for creating validation worker main functions.
 *
 * Extracts the common stdin→parse→run→stdout pattern shared by all
 * validation workers (eslint, prettier, stylelint).
 * @packageDocumentation
 */

import { ValidatorContext } from '../util/validator-context.js';
import type { FileValidationResults } from '../types.js';
import type { WorkerInput, WorkerOutput, WorkerTool } from './types.js';
import { readStdin } from './worker-utils.js';

/**
 * Tool loading result with tool module and local installation info.
 */
export interface ToolLoadResult<T> {
  /** The loaded tool module or constructor */
  tool: T | null;
  /** Local installation metadata if using project's tool */
  local?: { version: string };
}

/**
 * Result from running validation with the tool.
 */
export interface ValidationRunResult {
  /** Files that were checked by this validator */
  filesChecked: string[];
  /** Whether a config file was found (for prettier/stylelint) */
  configFound?: boolean;
}

/**
 * Configuration for error handling in the worker.
 */
export interface ErrorHandlerConfig {
  /**
   * Regex pattern to identify configuration-missing errors.
   * When matched, the worker treats it as a successful skip.
   */
  noConfigPattern?: RegExp;
  /**
   * Reason code to report when noConfigPattern matches.
   * @example 'no-eslint-config', 'no-stylelint-config'
   */
  noConfigReason?: string;
}

/**
 * Configuration for creating a validation worker.
 */
export interface ValidatorWorkerConfig<TTool> {
  /** Tool name for status reporting */
  toolName: WorkerTool;
  /**
   * Loads the validation tool from local or bundled sources.
   * @param searchPaths - Paths to search for local tool installation
   * @returns Tool load result with tool module and local metadata
   */
  loadTool: (searchPaths: string[]) => Promise<ToolLoadResult<TTool>>;
  /**
   * Runs validation on the provided files using the loaded tool.
   * @param files - Files to validate (absolute paths)
   * @param tool - The loaded tool module/constructor
   * @param ctx - Validator context for accumulating results
   * @param fix - Whether to auto-fix issues where possible
   * @returns Validation run result with files checked and config status
   */
  runValidation: (files: string[], tool: TTool, ctx: ValidatorContext, fix?: boolean) => Promise<ValidationRunResult>;
  /**
   * Optional file filter to select files for this tool.
   * @param files - All input files
   * @returns Filtered files to validate
   * @example (files) =\> files.filter(f =\> f.endsWith('.scss'))
   */
  filterFiles?: (files: string[]) => string[];
  /**
   * Optional reason to report when filterFiles returns empty array.
   * @example 'no-scss-files'
   */
  noFilesReason?: string;
  /**
   * Optional reason to report when tool fails to load.
   * If not provided, tool load failure results in error status.
   * @example 'no-stylelint'
   */
  noToolReason?: string;
  /** Error handling configuration */
  errorHandler?: ErrorHandlerConfig;
}

/**
 * Writes worker output to stdout.
 * @param output - Worker output message
 */
function writeOutput(output: WorkerOutput): void {
  process.stdout.write(JSON.stringify(output));
}

/**
 * Creates output for when tool cannot be loaded.
 * @param config - Worker configuration
 * @returns Worker output for tool-not-found scenario
 */
function createToolNotFoundOutput<TTool>(config: ValidatorWorkerConfig<TTool>): WorkerOutput {
  return config.noToolReason
    ? {
        success: true, // Treat as successful skip
        results: {},
        status: {
          tool: config.toolName,
          status: 'skipped',
          reason: config.noToolReason,
        },
      }
    : {
        success: false,
        results: {},
        status: {
          tool: config.toolName,
          status: 'failed',
          error: `Could not load ${config.toolName}`,
        },
        error: `Could not load ${config.toolName}`,
      };
}

/**
 * Creates success output after validation completes.
 * @param config - Worker configuration
 * @param fileResults - File validation results
 * @param result - Validation run result
 * @param local - Local tool metadata if using project's tool
 * @returns Worker output for success scenario
 */
function createSuccessOutput<TTool>(
  config: ValidatorWorkerConfig<TTool>,
  fileResults: FileValidationResults,
  result: ValidationRunResult,
  local?: { version: string },
): WorkerOutput {
  return {
    success: true,
    results: fileResults,
    status: {
      tool: config.toolName,
      status: 'ok',
      origin: local ? 'local' : 'bundled',
      version: local?.version,
      reason: result.configFound === false ? `${config.toolName}-defaults` : undefined,
      filesChecked: result.filesChecked,
    },
  };
}

/**
 * Creates error output from exception.
 * @param config - Worker configuration
 * @param fileResults - File validation results accumulated before error
 * @param error - Error thrown during validation
 * @returns Worker output for error scenario
 */
function createErrorOutput<TTool>(
  config: ValidatorWorkerConfig<TTool>,
  fileResults: FileValidationResults,
  error: unknown,
): WorkerOutput {
  const msg = error instanceof Error ? error.message : String(error);

  // Check for no-config pattern
  const isNoConfig = Boolean(config.errorHandler?.noConfigPattern?.test(msg));

  return {
    success: isNoConfig, // Treat no-config as successful skip; other errors are failures
    results: fileResults,
    status: isNoConfig
      ? {
          tool: config.toolName,
          status: 'skipped',
          reason: config.errorHandler?.noConfigReason,
        }
      : { tool: config.toolName, status: 'failed', error: msg },
    error: isNoConfig ? undefined : msg,
  };
}

/**
 * Creates a validation worker main function with the common boilerplate.
 *
 * Handles:
 * - Reading stdin and parsing WorkerInput
 * - Creating fileResults and ValidatorContext
 * - Filtering files (if filterFiles provided)
 * - Loading the tool
 * - Running validation
 * - Special error handling (no-config patterns)
 * - Writing WorkerOutput to stdout
 * @param config - Worker configuration
 * @returns Main function to execute in the worker process
 */
export function createValidatorWorker<TTool>(config: ValidatorWorkerConfig<TTool>): () => Promise<void> {
  return async (): Promise<void> => {
    const inputJson = await readStdin();
    const input: WorkerInput = JSON.parse(inputJson);

    const fileResults: FileValidationResults = {};
    const ctx = new ValidatorContext(fileResults);

    // Apply optional file filter
    const filesToValidate = config.filterFiles ? config.filterFiles(input.files) : input.files;

    // Handle empty file set after filtering
    if (filesToValidate.length === 0 && config.noFilesReason) {
      writeOutput({
        success: true,
        results: {},
        status: {
          tool: config.toolName,
          status: 'skipped',
          reason: config.noFilesReason,
        },
      });
      return;
    }

    try {
      // Load the validation tool
      const { tool, local } = await config.loadTool([process.cwd()]);

      // Handle tool not found
      if (!tool) {
        const output = createToolNotFoundOutput(config);
        writeOutput(output);
        return;
      }

      // Run validation
      const result = await config.runValidation(filesToValidate, tool, ctx, input.options.fix);

      // Success output
      writeOutput(createSuccessOutput(config, fileResults, result, local));
    } catch (error) {
      writeOutput(createErrorOutput(config, fileResults, error));
    }
  };
}
