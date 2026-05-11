/**
 * Validation types for the workspace validator.
 * @packageDocumentation
 */

/**
 * Validation tools that can run independently.
 */
export type ValidationTool = 'prettier' | 'eslint' | 'stylelint' | 'typescript';

/** Tool name for built-in or host-provided validation results. */
export type ValidationToolName = ValidationTool | (string & {});

/**
 * Base validation result for each tool's finding.
 */
export interface ValidationResult {
  /** Tool that generated this result */
  tool: ValidationToolName;
  /** Validation message */
  message: string;
  /** Severity level */
  severity: 'error' | 'warning' | 'info';
  /** Line number (1-based) */
  line?: number;
  /** Column number (1-based) */
  column?: number;
  /** End line number (1-based) */
  endLine?: number;
  /** End column number (1-based) */
  endColumn?: number;
  /** Whether this issue can be auto-fixed */
  fixable?: boolean;
  /** Whether this issue was automatically fixed */
  fixedAutomatically?: boolean;
  /** ESLint rule ID or TypeScript error code */
  ruleId?: string;
}

/**
 * File-centric validation results keyed by file path.
 */
export type FileValidationResults = Record<string, ValidationResult[]>;

/**
 * Validation runtime profile.
 *
 * `standalone` uses the framework workspace sizing. `full-workspace` runs the
 * same validator against a larger repository topology, which has a larger
 * TypeScript graph and needs a different worker memory budget.
 */
export type ValidateProfile = 'standalone' | 'full-workspace';

/**
 * Options for validation.
 */
export interface ValidateOptions {
  /** Specific files or directories to validate */
  files?: string[];
  /** Glob pattern to match files */
  glob?: string;
  /** Auto-fix issues where possible */
  fix?: boolean;
  /** Use caching for improved speed */
  cache?: boolean;
  /** Optional explicit tsconfig.json path */
  tsConfigFile?: string;
  /** Show verbose output including files checked per tool */
  verbose?: boolean;
  /** Runtime profile controlling worker sizing and repo topology assumptions */
  profile?: ValidateProfile;
  /** Optional subset of validation tools to run */
  tools?: ValidationTool[];
}

/**
 * Tool execution status.
 */
export type ToolStatus = 'ok' | 'skipped' | 'failed';

/**
 * Status information for a validation tool.
 */
export interface ToolRunStatus {
  /** Tool name */
  tool: ValidationToolName;
  /** Execution status */
  status: ToolStatus;
  /** Reason for skip/failure (e.g., 'no-eslint-config') */
  reason?: string;
  /** Error message if failed */
  error?: string;
  /** Whether using local or bundled tool */
  origin?: 'local' | 'bundled';
  /** Tool version if local */
  version?: string;
  /** Files checked by this tool (for verbose output) */
  filesChecked?: string[];
}

/**
 * Validation summary with results and statistics.
 */
export interface ValidationSummary {
  /** File-centric view for AI processing */
  fileResults: FileValidationResults;
  /** All files processed (optional expansion when compact=false) */
  processedFiles?: string[];
  /** Total number of files validated */
  totalFiles: number;
  /** Number of files with errors */
  filesWithErrors: number;
  /** Files that can be auto-fixed */
  fixableFiles: string[];
  /** Files needing manual intervention */
  unfixableFiles: string[];
  /** Suggested actions for AI agent */
  suggestedActions: Array<{
    file: string;
    action: 'prettier-fix' | 'eslint-fix' | 'stylelint-fix' | 'manual-fix';
    description: string;
  }>;
  /** Per-tool execution status to preserve summary on partial failures */
  toolStatuses: ToolRunStatus[];
}
