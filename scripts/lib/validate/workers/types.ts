/**
 * Worker protocol types for forked validation processes.
 *
 * Each validator runs in its own process with isolated memory.
 * Communication happens via stdin (input) and stdout (output) with JSON.
 * @packageDocumentation
 */

import type { FileValidationResults, ToolRunStatus, ValidateProfile, ValidationTool } from '../types.js';

/**
 * Tool names that can be validated in workers.
 */
export type WorkerTool = ValidationTool;

/**
 * Input message sent to worker via stdin.
 */
export interface WorkerInput {
  /** Files to validate (absolute paths) */
  files: string[];
  /** Validation options */
  options: {
    /** Auto-fix issues where possible */
    fix?: boolean;
    /** Use caching for improved speed */
    cache?: boolean;
    /** Show verbose output */
    verbose?: boolean;
    /** TypeScript config path (for typescript worker) */
    tsConfigFile?: string;
    /** Runtime profile controlling worker sizing */
    profile?: ValidateProfile;
  };
}

/**
 * Output message sent from worker via stdout.
 */
export interface WorkerOutput {
  /** Whether validation completed without throwing */
  success: boolean;
  /** Validation results keyed by file path */
  results: FileValidationResults;
  /** Tool execution status */
  status: ToolRunStatus;
  /** Error message if success is false */
  error?: string;
}

/**
 * Configuration for spawning a worker process.
 */
export interface WorkerConfig {
  /** Tool to validate with */
  tool: WorkerTool;
  /** Timeout in milliseconds (default: 600000 = 10 minutes) */
  timeoutMs?: number;
}
