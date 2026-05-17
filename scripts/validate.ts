#!/usr/bin/env tsx
/**
 * CLI entry point for validation.
 *
 * Runs prettier, eslint, and TypeScript validation on the codebase using the
 * selected runtime profile.
 * @example
 * ```bash
 * # Validate all files
 * tsx scripts/validate.ts
 *
 * # Validate and auto-fix issues
 * tsx scripts/validate.ts --fix
 *
 * # Validate specific path
 * tsx scripts/validate.ts packages/core
 *
 * # Output as JSON
 * tsx scripts/validate.ts --json
 * ```
 */

import path from 'path';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { WorkspaceValidator } from './lib/validate/index.js';
import type {
  ValidateOptions,
  ValidationSummary,
  ToolRunStatus,
  ValidationResult,
  ValidateProfile,
  ValidationTool,
} from './lib/validate/index.js';

const DEFAULT_VALIDATE_PROFILE: ValidateProfile = (() => {
  const raw = process.env['MAKAIO_VALIDATE_PROFILE'];
  if (raw === undefined) return 'standalone';
  if (raw === 'full-workspace' || raw === 'standalone') return raw;
  throw new Error(`Invalid MAKAIO_VALIDATE_PROFILE="${raw}". Use "standalone" or "full-workspace".`);
})();

const VALIDATION_TOOLS: ValidationTool[] = ['prettier', 'eslint', 'stylelint', 'typescript'];

export interface ValidateCliHooks {
  /**
   * Allows host wrappers to add repository-specific validation results after
   * the built-in framework validators run and before output is formatted.
   * @param summary - Mutable validation summary.
   * @param options - Resolved validation options used for this run.
   */
  afterValidate?: (summary: ValidationSummary, options: ValidateOptions) => Promise<void> | void;
}

interface ParsedCliArgs {
  flags: {
    json: boolean;
    cache: boolean;
    showActions: boolean;
    verbose: boolean;
    help: boolean;
    fix: boolean;
  };
  profile: ValidateProfile;
  tools?: ValidationTool[];
  tsConfigFile?: string;
  files?: string[];
  globPattern?: string;
}

interface CliParseState {
  tsConfigFile?: string;
  profile: ValidateProfile;
  fix: boolean;
  tools?: ValidationTool[];
}

interface ParsedOption {
  handled: boolean;
  nextIndex: number;
}

interface RequiredFlagValue {
  value: string;
  nextIndex: number;
}

/**
 * Parses a comma-separated tool list from CLI arguments.
 * @param raw - Raw tool argument value
 * @returns Validated validation tools
 */
function parseToolList(raw: string): ValidationTool[] {
  const tools = raw.split(',').filter((tool) => tool.length > 0);
  for (const tool of tools) {
    if (!VALIDATION_TOOLS.includes(tool as ValidationTool)) {
      throw new Error(`Invalid value for --tool. Use one of: ${VALIDATION_TOOLS.join(', ')}.`);
    }
  }
  return tools as ValidationTool[];
}

/**
 * Parses a validation profile CLI value.
 * @param value - Raw profile value
 * @returns Validated profile
 */
function parseProfile(value: string): ValidateProfile {
  if (value === 'full-workspace' || value === 'standalone') {
    return value;
  }
  throw new Error('Invalid value for --profile. Use "standalone" or "full-workspace".');
}

/**
 * Reads the value following a flag that requires a separate argument.
 * @param args - Full CLI argument list
 * @param index - Current flag index
 * @param flag - Flag name for error messages
 * @returns The flag value and next parser index
 */
function readRequiredFlagValue(
  args: string[],
  index: number,
  flag: '--profile' | '--tool' | '--tools' | '--tsconfig',
): RequiredFlagValue {
  const next = args[index + 1];
  if (!next || next.startsWith('-')) {
    const expected =
      flag === '--profile'
        ? '"standalone" or "full-workspace"'
        : flag === '--tsconfig'
          ? 'a tsconfig path'
          : `one of: ${VALIDATION_TOOLS.join(', ')}`;
    throw new Error(`Invalid value for ${flag}. Use ${expected}.`);
  }
  return { value: next, nextIndex: index + 1 };
}

/**
 * Applies a known long option to parser state.
 * @param arg - Current CLI argument
 * @param args - Full CLI argument list
 * @param index - Current argument index
 * @param state - Mutable parser state
 * @returns Whether the option was handled and the next parser index
 */
function applyKnownOption(arg: string, args: string[], index: number, state: CliParseState): ParsedOption {
  if (arg === '--tsconfig') {
    const parsed = readRequiredFlagValue(args, index, '--tsconfig');
    state.tsConfigFile = parsed.value;
    return { handled: true, nextIndex: parsed.nextIndex };
  }
  if (arg.startsWith('--tsconfig=')) {
    state.tsConfigFile = arg.slice('--tsconfig='.length);
    return { handled: true, nextIndex: index };
  }
  if (arg === '--tool' || arg === '--tools') {
    const parsed = readRequiredFlagValue(args, index, arg);
    state.tools = parseToolList(parsed.value);
    return { handled: true, nextIndex: parsed.nextIndex };
  }
  if (arg.startsWith('--tool=')) {
    state.tools = parseToolList(arg.slice('--tool='.length));
    return { handled: true, nextIndex: index };
  }
  if (arg.startsWith('--tools=')) {
    state.tools = parseToolList(arg.slice('--tools='.length));
    return { handled: true, nextIndex: index };
  }
  if (arg === '--profile') {
    const parsed = readRequiredFlagValue(args, index, '--profile');
    state.profile = parseProfile(parsed.value);
    return { handled: true, nextIndex: parsed.nextIndex };
  }
  if (arg.startsWith('--profile=')) {
    state.profile = parseProfile(arg.slice('--profile='.length));
    return { handled: true, nextIndex: index };
  }
  if (arg === '--fix') {
    state.fix = true;
    return { handled: true, nextIndex: index };
  }
  if (arg === '--no-fix') {
    state.fix = false;
    return { handled: true, nextIndex: index };
  }
  if (arg === '--cache') {
    return { handled: true, nextIndex: index };
  }
  if (arg === '--no-cache') {
    return { handled: true, nextIndex: index };
  }
  return { handled: false, nextIndex: index };
}

/**
 * Parses command line arguments.
 * @param args - Raw argv array (without node and script path)
 * @returns Parsed CLI arguments
 */
export function parseCliArgs(args: string[]): ParsedCliArgs {
  const flags: string[] = [];
  const positional: string[] = [];
  const state: CliParseState = {
    profile: DEFAULT_VALIDATE_PROFILE,
    fix: true,
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg.startsWith('--')) {
      const parsed = applyKnownOption(arg, args, index, state);
      if (parsed.handled) {
        index = parsed.nextIndex;
        continue;
      }
      flags.push(arg);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  const hasMultipleFiles = positional.length > 1;
  const files = hasMultipleFiles ? positional : undefined;
  const globPattern = !hasMultipleFiles && positional.length === 1 ? positional[0] : undefined;

  return {
    flags: {
      json: flags.includes('--json'),
      cache: !args.includes('--no-cache'),
      showActions: flags.includes('--show-actions'),
      verbose: flags.includes('--verbose'),
      help: flags.includes('--help'),
      fix: state.fix,
    },
    profile: state.profile,
    tools: state.tools,
    tsConfigFile: state.tsConfigFile,
    files,
    globPattern,
  };
}

/**
 * Shows help message and exits.
 */
function showHelp(): never {
  console.info(`
${chalk.bold('Usage:')} validate [options] [glob-pattern]

${chalk.bold('Options:')}
  --json         Output results as JSON
  --fix          Apply auto-fixable changes (default: true)
  --no-fix       Report issues without modifying files
  --cache        Enable validator caches (default: true)
  --no-cache     Disable validator caches
  --profile      Validation topology: standalone or full-workspace
  --tsconfig     Explicit tsconfig.json path for TypeScript validation
  --tool         Run one validation tool: prettier, eslint, stylelint, typescript
  --tools        Run comma-separated validation tools
  --verbose      Show files checked by each tool (prettier, eslint, typescript)
  --show-actions Show suggested actions for AI
  --help         Show this help message

${chalk.bold('Examples:')}
  validate                              # Validate and auto-fix all files
  validate "src/**/*.ts"                # Validate src TypeScript files
  validate --json "packages/bus/**/*"   # Validate bus package, output JSON
  validate --profile full-workspace     # Validate with full workspace worker sizing
  validate --tsconfig tsconfig.json     # Validate using explicit tsconfig
  validate --tool typescript            # Validate using only one tool
  validate file1.ts file2.ts file3.ts   # Validate specific files
`);
  process.exit(0);
}

/**
 * Formats tool status output.
 * @param toolStatuses - Tool execution statuses
 * @returns Formatted string or empty if no issues
 */
function formatToolStatus(toolStatuses: ToolRunStatus[] | undefined): string {
  const failed = toolStatuses?.filter((s) => s.status === 'failed') || [];
  const skipped = toolStatuses?.filter((s) => s.status === 'skipped') || [];

  if (failed.length === 0 && skipped.length === 0) {
    return '';
  }

  const lines: string[] = [chalk.blue.bold('\n🛠 Tool Status:')];
  for (const s of [...failed, ...skipped]) {
    const label = s.status === 'failed' ? chalk.red('failed') : chalk.yellow('skipped');
    const reason = s.reason ? ` (${s.reason})` : '';
    const err = s.error ? `: ${s.error}` : '';
    lines.push(`  - ${s.tool}: ${label}${reason}${err}`);
  }
  return lines.join('\n');
}

/**
 * Formats verbose output showing files checked by each tool.
 * @param toolStatuses - Tool execution statuses with filesChecked
 * @returns Formatted string showing files per tool
 */
function formatVerboseOutput(toolStatuses: ToolRunStatus[] | undefined): string {
  if (!toolStatuses || toolStatuses.length === 0) {
    return '';
  }

  const lines: string[] = [chalk.blue.bold('\n📋 Files checked by tool:')];

  for (const status of toolStatuses) {
    const filesChecked = status.filesChecked || [];
    const statusIcon = status.status === 'ok' ? '✓' : status.status === 'skipped' ? '⊘' : '✗';
    const statusColor = status.status === 'ok' ? chalk.green : status.status === 'skipped' ? chalk.yellow : chalk.red;

    lines.push(statusColor(`\n  ${statusIcon} ${status.tool} (${filesChecked.length} files)`));

    if (filesChecked.length > 0) {
      for (const file of filesChecked) {
        const relativePath = path.relative(process.cwd(), file);
        lines.push(chalk.gray(`      ${relativePath}`));
      }
    } else if (status.status === 'skipped') {
      lines.push(chalk.gray(`      (skipped: ${status.reason || 'unknown reason'})`));
    }
  }

  return lines.join('\n');
}

/**
 * Formats file results output.
 * @param file - File path
 * @param results - Validation results for the file
 * @returns Formatted string
 */
function formatFileResults(file: string, results: ValidationResult[]): string {
  const lines: string[] = [];
  const relativePath = process.env.VALIDATE_FULL_FILE_PATH ? `file:///${file}` : path.relative(process.cwd(), file);
  lines.push(chalk.yellow(`\n${relativePath}:`));

  for (const result of results) {
    const icon = result.severity === 'error' ? '❌' : result.severity === 'warning' ? '⚠️' : 'ℹ️';
    const location = result.line ? `:${result.line}:${result.column}` : '';
    const ruleInfo = result.ruleId ? ` (${result.ruleId})` : '';

    lines.push(`  ${icon} [${result.tool}${location}] ${result.message}${ruleInfo}`);
  }
  return lines.join('\n');
}

/**
 * Formats summary output.
 * @param summary - Validation summary
 * @param showActions - Whether to show suggested actions
 * @returns Formatted string
 */
function formatSummary(summary: ValidationSummary, showActions: boolean): string {
  const lines: string[] = [
    chalk.blue.bold('\n📊 Summary:'),
    `  Total files checked: ${summary.totalFiles}`,
    `  Files with issues: ${summary.filesWithErrors}`,
  ];

  if (summary.fixableFiles.length > 0) {
    lines.push(chalk.yellow(`  Auto-fixable files: ${summary.fixableFiles.length}`));
  }

  if (summary.unfixableFiles.length > 0) {
    lines.push(chalk.red(`  Manual fixes needed: ${summary.unfixableFiles.length}`));
  }

  if (showActions && summary.suggestedActions.length > 0) {
    lines.push(chalk.blue.bold('\n🤖 Suggested Actions:'));
    for (const action of summary.suggestedActions) {
      const relativePath = path.relative(process.cwd(), action.file);
      lines.push(`  • ${relativePath}: ${action.description}`);
    }
  }

  return lines.join('\n');
}

/**
 * Builds a compact single-line summary of validation results.
 *
 * Counts errors, warnings, and auto-fixed issues across all files to produce
 * a terse status line optimized for LLM consumption.
 * @param summary - Validation summary with file results
 * @returns Single-line summary string (e.g., "validate: 150 files | 3 errors, 1 warning (2 auto-fixed)")
 */
function formatCompactSummary(summary: ValidationSummary): string {
  const allResults = Object.values(summary.fileResults).flat();
  const errors = allResults.filter((r) => r.severity === 'error' && !r.fixedAutomatically).length;
  const warnings = allResults.filter((r) => r.severity === 'warning' && !r.fixedAutomatically).length;
  const autoFixed = allResults.filter((r) => r.fixedAutomatically).length;

  const parts: string[] = [`${summary.totalFiles} files`];

  if (errors === 0 && warnings === 0) {
    parts.push('clean');
  } else {
    if (errors > 0) parts.push(`${errors} error${errors !== 1 ? 's' : ''}`);
    if (warnings > 0) parts.push(`${warnings} warning${warnings !== 1 ? 's' : ''}`);
  }

  const suffix = autoFixed > 0 ? ` (${autoFixed} auto-fixed)` : '';
  return `validate: ${parts.join(' | ')}${suffix}`;
}

/**
 * Formats output when no issues found.
 * @param summary - Validation summary
 * @param isEmpty - Whether file results are empty
 * @returns Formatted string
 */
function formatNoIssuesOutput(summary: ValidationSummary, isEmpty: boolean): string {
  const message = isEmpty ? chalk.green('✨ No issues found') : chalk.green('✅ All files passed validation!');

  const toolStatus = formatToolStatus(summary.toolStatuses);
  return toolStatus ? `${message}${toolStatus}` : message;
}

/**
 * Formats output when issues are found.
 * @param summary - Validation summary
 * @param showActions - Whether to show suggested actions
 * @returns Formatted string
 */
function formatIssuesOutput(summary: ValidationSummary, showActions: boolean): string {
  const lines: string[] = [chalk.blue.bold('\nValidation Results:\n')];

  for (const [file, results] of Object.entries(summary.fileResults)) {
    if (results.length > 0) {
      lines.push(formatFileResults(file, results));
    }
  }

  lines.push(formatSummary(summary, showActions));
  return lines.join('\n');
}

/**
 * Runs the validation CLI and returns the process exit code.
 * @param args - CLI arguments without the executable and script path.
 * @param hooks - Optional host hooks that can extend validation before output.
 * @returns Process exit code for the validation run.
 */
export async function runValidateCli(args: string[], hooks: ValidateCliHooks = {}): Promise<number> {
  const parsed = parseCliArgs(args);

  if (parsed.flags.help) {
    showHelp();
  }

  const options: ValidateOptions = {
    files: parsed.files,
    glob: parsed.globPattern,
    fix: parsed.flags.fix,
    cache: parsed.flags.cache,
    verbose: parsed.flags.verbose,
    profile: parsed.profile,
    tools: parsed.tools,
    tsConfigFile: parsed.tsConfigFile,
  };

  try {
    const validator = new WorkspaceValidator();
    const summary = await validator.validate(options);
    await hooks.afterValidate?.(summary, options);

    if (parsed.flags.json) {
      console.info(JSON.stringify(summary, null, 2));
      return 0;
    }

    const isEmpty = Object.keys(summary.fileResults).length === 0;
    const hasIssues = Object.values(summary.fileResults).some((r) => r.length > 0);
    const anyFailed = summary.toolStatuses?.some((s) => s.status === 'failed');

    if (isEmpty || !hasIssues) {
      let output = formatNoIssuesOutput(summary, isEmpty);
      if (parsed.flags.verbose) {
        output += formatVerboseOutput(summary.toolStatuses);
      }
      output += `\n${formatCompactSummary(summary)}`;
      console.info(output);
      return anyFailed ? 2 : 0;
    }

    let output = formatIssuesOutput(summary, parsed.flags.showActions);
    if (parsed.flags.verbose) {
      output += formatVerboseOutput(summary.toolStatuses);
    }
    output += `\n\n${formatCompactSummary(summary)}`;
    console.info(output);

    return summary.filesWithErrors > 0 ? 1 : anyFailed ? 2 : 0;
  } catch (error: Error | unknown) {
    console.error(chalk.red('Validation failed:'), error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/**
 * Main entry point.
 */
async function main(): Promise<void> {
  process.exit(await runValidateCli(process.argv.slice(2)));
}

/**
 * Checks whether this module is the process entrypoint instead of an imported CLI helper.
 * @returns True when the current process launched this file directly.
 */
function isDirectCliExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && path.resolve(entry) === fileURLToPath(import.meta.url);
}

// Run when executed directly or imported by the workspace wrapper, but not
// when imported for unit tests. Vitest sets the VITEST environment variable
// before importing test modules, so its presence reliably signals test mode.
if (!process.env['VITEST'] && isDirectCliExecution()) {
  main();
}
