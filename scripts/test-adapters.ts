#!/usr/bin/env npx tsx

import {
  colors,
  CONFORMANCE_PATH,
  discoverAdapters,
  discoverConformanceTests,
  loadAdapterConfig,
  printSummary,
  runAdapterQueueWithSchemaArtifact,
} from './lib/conformance/index.js';
import type { AdapterResult, RunOptions } from './lib/conformance/index.js';

const start = Date.now();
const DEFAULT_CONCURRENCY = 2;

/**
 * Reads the value that follows a CLI option.
 * @param args - Raw CLI arguments
 * @param index - Index of the option whose value is being read
 * @param option - Option name for error output
 * @returns The option value
 */
function requireOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    console.error(`${colors.red}Missing value for ${option}${colors.reset}`);
    process.exit(1);
  }
  return value;
}

/**
 * Parse a positive integer CLI option.
 * @param args - Raw CLI arguments
 * @param index - Index of the option whose value is being read
 * @param option - Option name for error output
 * @returns Positive integer option value
 */
function parsePositiveIntegerOption(args: string[], index: number, option: string): number {
  const value = Number(requireOptionValue(args, index, option));
  if (!Number.isInteger(value) || value < 1) {
    console.error(`${colors.red}${option} must be a positive integer${colors.reset}`);
    process.exit(1);
  }
  return value;
}

function parseArgs(): RunOptions {
  const args = process.argv.slice(2);
  const allAdapters = discoverAdapters();

  const options: RunOptions = {
    adapters: [],
    filePatterns: [],
    excludePatterns: [],
    testNamePattern: undefined,
    concurrencyOverride: undefined,
    adapterParallelism: 10,
    verbose: false,
    dryRun: false,
    allAdapters: true,
    all: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--adapter' || arg === '-a') {
      if (options.all) {
        console.error(`${colors.red}--adapter cannot be combined with --all${colors.reset}`);
        process.exit(1);
      }
      options.allAdapters = false;
      const value = requireOptionValue(args, i, arg);
      i++;
      const adapters = value.split(',').map((s) => s.trim());
      for (const adapter of adapters) {
        if (!allAdapters.includes(adapter)) {
          console.error(`${colors.red}Unknown adapter: ${adapter}${colors.reset}`);
          console.error(`Available adapters: ${allAdapters.join(', ')}`);
          process.exit(1);
        }
        if (options.adapters.includes(adapter)) continue;
        options.adapters.push(adapter);
      }
    } else if (arg === '--workers' || arg === '-w') {
      options.workers = parsePositiveIntegerOption(args, i, arg);
      i++;
    } else if (arg === '--all') {
      if (!options.allAdapters || options.adapters.length > 0) {
        console.error(`${colors.red}--all cannot be combined with --adapter${colors.reset}`);
        process.exit(1);
      }
      options.all = true;
    } else if (arg === '--testNamePattern' || arg === '-t') {
      options.testNamePattern = requireOptionValue(args, i, arg);
      i++;
    } else if (arg === '--exclude') {
      options.excludePatterns.push(requireOptionValue(args, i, arg));
      i++;
    } else if (arg === '--phase') {
      options.phase = requireOptionValue(args, i, arg);
      i++;
    } else if (arg === '--result-output') {
      options.resultOutputPath = requireOptionValue(args, i, arg);
      i++;
    } else if (arg === '--schema-violations-output') {
      options.schemaViolationsOutputPath = requireOptionValue(args, i, arg);
      i++;
    } else if (arg === '--concurrency' || arg === '-c') {
      options.concurrencyOverride = parsePositiveIntegerOption(args, i, arg);
      i++;
    } else if (arg === '--parallelism' || arg === '-p') {
      options.adapterParallelism = parsePositiveIntegerOption(args, i, arg);
      i++;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--dry-run' || arg === '-n') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp(allAdapters);
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      options.filePatterns.push(arg);
    } else {
      console.error(`${colors.red}Unknown option: ${arg}${colors.reset}`);
      printHelp(allAdapters);
      process.exit(1);
    }
  }

  if (options.adapters.length === 0) options.adapters = allAdapters;
  return options;
}

function printHelp(allAdapters: string[]): void {
  console.info(`
${colors.bold}Conformance Test Runner${colors.reset}

Usage: npx tsx scripts/test-adapters.ts [globs...] [options]

Arguments:
  [globs...]              Test file patterns (default: **/*.test.ts)

Options:
  -a, --adapter <name>    Adapter(s) to test (comma-separated)
                          Available: ${allAdapters.join(', ')}
  --all                   Test all adapters (DANGER: costs $$$)
  -t, --testNamePattern   Filter tests by name pattern (regex)
  --exclude <glob>        Exclude matching conformance test files
  --phase <name>          Label this run in the JSON result artifact
  --result-output <path>  Write a machine-readable run result artifact
  --schema-violations-output <path>
                          Write schema violations to this path
  -c, --concurrency <n>   Override max concurrent test files per adapter
  -p, --parallelism <n>   Max adapters to run in parallel (default: 10)
  -w, --workers <n>       Max workers to run in parallel
  -v, --verbose           Verbose output
  -n, --dry-run           Show what would run without executing tests
  -h, --help              Show this help message

Examples:
  npx tsx scripts/test-adapters.ts -a claude-code
  npx tsx scripts/test-adapters.ts simple -t "idle" -a claude-code
`);
}

async function main() {
  const options = parseArgs();

  if (!options.all && options.allAdapters) {
    console.error(
      `Running tests for all adapters costs time and money. Please pass -a [adapters].\nAvailable: ${options.adapters.join(', ')}`,
    );
    process.exit(0);
  }

  const testFiles = await discoverConformanceTests(options.filePatterns, options.excludePatterns);
  if (testFiles.length === 0) {
    console.error(
      `${colors.red}No test files found matching: ${options.filePatterns.join(', ') || '**/*.test.ts'}${
        options.excludePatterns.length ? ` (excluded: ${options.excludePatterns.join(', ')})` : ''
      }${colors.reset}`,
    );
    process.exit(1);
  }

  console.info(
    `${colors.bold}Conformance Test Runner${colors.reset}${options.dryRun ? ` ${colors.yellow}(DRY RUN)${colors.reset}` : ''}`,
  );
  console.info(`Adapters: ${options.adapters.join(', ')}`);
  console.info(
    `Test files: ${testFiles.length}${options.filePatterns.length ? ` (pattern: ${options.filePatterns.join(', ')})` : ''}`,
  );
  if (options.excludePatterns.length) console.info(`Excluded files: ${options.excludePatterns.join(', ')}`);
  if (options.phase) console.info(`Phase: ${options.phase}`);
  if (options.testNamePattern) console.info(`Test filter: ${colors.cyan}${options.testNamePattern}${colors.reset}`);
  console.info(
    `Concurrency: ${options.concurrencyOverride !== undefined ? `${options.concurrencyOverride} (cli override)` : 'per-adapter config'}`,
  );
  console.info(`Adapter parallelism: ${options.adapterParallelism}`);

  if (options.dryRun) {
    console.info(`\n${colors.bold}Test files:${colors.reset}`);
    for (const file of testFiles) console.info(`  ${file.replace(CONFORMANCE_PATH + '/', '')}`);

    console.info(`\n${colors.bold}Per-adapter concurrency:${colors.reset}`);
    for (const adapter of options.adapters) {
      const config = await loadAdapterConfig(adapter);
      const concurrency = options.concurrencyOverride ?? config?.concurrency ?? DEFAULT_CONCURRENCY;
      const source =
        options.concurrencyOverride !== undefined ? 'cli' : config?.concurrency !== undefined ? 'config' : 'default';
      console.info(`  ${adapter}: ${concurrency} [${source}]`);
    }
    console.info(`\n${colors.dim}No tests were executed (dry run mode).${colors.reset}`);
    return;
  }

  const results: AdapterResult[] = [];
  const schemaViolationsEnvPath = process.env.SCHEMA_VIOLATIONS_PATH?.trim();
  const artifactPath = options.schemaViolationsOutputPath ?? (schemaViolationsEnvPath || 'schema-violations.json');
  let exitCode = 0;
  let thrownError: unknown;
  let didThrow = false;

  try {
    await runAdapterQueueWithSchemaArtifact({
      adapters: options.adapters,
      testFiles,
      testNamePattern: options.testNamePattern,
      concurrencyOverride: options.concurrencyOverride,
      adapterParallelism: options.adapterParallelism,
      verbose: options.verbose,
      workers: options.workers,
      results,
      schemaViolationsPath: artifactPath,
      phase: options.phase,
      resultOutputPath: options.resultOutputPath,
    });
    exitCode = results.some((r) => r.failed > 0) ? 1 : 0;
  } catch (error) {
    thrownError = error;
    didThrow = true;
  } finally {
    printSummary(results, start, artifactPath);
  }

  if (didThrow) throw thrownError;
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(`${colors.red}Fatal error:${colors.reset}`, err);
  process.exit(1);
});
