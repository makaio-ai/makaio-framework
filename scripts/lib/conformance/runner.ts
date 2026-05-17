import { createVitest, type TestModule, TestSuite, type TestCase } from 'vitest/node';
import { TestError } from 'vitest';
import { join } from 'path';
import { AdapterResult, colors, parseStackLocation, type InternalVitestTask } from './types.js';
import { loadAdapterConfig } from './discovery.js';
import { parseViolationsFromLogs, schemaViolationDedupKey } from './log-parser.js';
import { loadConformanceProviderDefinitions } from './provider-catalog.js';
import { MAKAIO_CONFORMANCE_PROVIDER_DEFINITIONS_ENV } from '@makaio/ai-adapters-core';

const adapterReporterPath = join(import.meta.dirname, 'adapter-reporter.js');
const DEFAULT_CONCURRENCY = 2;

/**
 * Runs conformance tests for a single adapter.
 *
 * Creates a vitest instance per adapter, passes all test files as specifications,
 * and lets vitest's built-in worker pool handle parallelism via `maxWorkers`.
 * @param adapter - Adapter name to test
 * @param testFiles - Array of test file paths
 * @param testNamePattern - Optional regex pattern to filter tests
 * @param concurrencyOverride - Optional concurrency override
 * @param verbose - Whether to enable verbose output
 * @param maxWorkers - Optional max worker count
 * @returns Test result for the adapter
 */
export async function runAdapterTests(
  adapter: string,
  testFiles: string[],
  testNamePattern: string | undefined,
  concurrencyOverride: number | undefined,
  verbose: boolean,
  maxWorkers?: number,
): Promise<AdapterResult> {
  const result: AdapterResult = {
    adapter,
    passed: 0,
    failed: 0,
    skipped: 0,
    duration: 0,
    errors: [],
    unhandledErrors: [],
    schemaViolations: [],
  };

  const startTime = Date.now();

  let concurrency = concurrencyOverride ?? DEFAULT_CONCURRENCY;
  let hookTimeout: number | undefined;
  if (concurrencyOverride === undefined) {
    const adapterConfig = await loadAdapterConfig(adapter);
    if (adapterConfig?.concurrency !== undefined) {
      concurrency = adapterConfig.concurrency;
    }
    hookTimeout = adapterConfig?.defaultTimeout;
  }
  const providerDefinitions = await loadConformanceProviderDefinitions();

  const vitest = await createVitest('test', {
    watch: false,
    reporters: [adapterReporterPath],
    hookTimeout,
    // Allow workers extra time to flush pending RPC (e.g. console.log) before
    // the channel closes. Prevents EnvironmentTeardownError with adapters that
    // spawn long-lived server processes (codex-app-server).
    teardownTimeout: 15_000,
    onUnhandledError: (error: (TestError | Error) & { type: string }) => {
      const { file, line } = parseStackLocation(error);
      result.unhandledErrors.push({
        name: error.name,
        message: error.message,
        file,
        line,
      });
    },
    globals: true,
    environment: 'node',
    pool: 'forks',
    // Use adapter concurrency to control vitest's worker pool directly
    // instead of layering a userland PQueue on top.
    maxWorkers: maxWorkers ?? concurrency,
    fileParallelism: (maxWorkers ?? concurrency) > 1,
    include: [],
    testNamePattern,
    env: {
      MAKAIO_TEST_ADAPTER: adapter,
      [MAKAIO_CONFORMANCE_PROVIDER_DEFINITIONS_ENV]: JSON.stringify(providerDefinitions),
      VERBOSE: String(process.env.MAKAIO_DEBUG === 'true' || verbose),
    },
  });

  try {
    await vitest.init();

    const project = vitest.projects[0];
    if (!project) {
      console.error(`${colors.red}No project found for ${adapter}${colors.reset}`);
      return result;
    }

    const specs = testFiles.map((file) => project.createSpecification(file));
    await vitest.runTestSpecifications(specs);

    const seenViolationKeys = new Set<string>();
    for (const module of vitest.state.getTestModules()) {
      collectModuleResults(module, result);
      for (const child of module.children.array()) {
        collectViolationsFromTask(child, result, seenViolationKeys);
      }
    }
  } finally {
    await vitest.close();
  }

  result.duration = Date.now() - startTime;
  return result;
}

/**
 * Collects test results from a module.
 *
 * When a module fails to load (import error, syntax error, etc.), it has zero
 * children but carries errors on `module.errors()`. We surface these as failures
 * so they aren't silently swallowed.
 * @param module - The test module to collect from
 * @param result - The adapter result to accumulate into
 */
function collectModuleResults(module: TestModule, result: AdapterResult): void {
  for (const child of module.children.array()) {
    collectChildResults(child, result);
  }

  // Surface module-level errors (import failures, syntax errors, etc.)
  if (module.state() === 'failed') {
    const moduleErrors = module.errors();
    if (moduleErrors.length > 0 && result.passed === 0 && result.failed === 0) {
      result.failed++;
      for (const error of moduleErrors) {
        result.errors.push({
          test: module.relativeModuleId,
          message: error.message ?? 'Module failed to load',
          file: module.moduleId,
        });
      }
    }
  }
}

/**
 * Recursively collects results from test children.
 *
 * When a suite's beforeAll/beforeEach hook fails, Vitest marks the suite as
 * "failed" but its individual tests as "skipped" (they never ran). We detect
 * this and reclassify those skipped tests as failures so the summary accurately
 * reflects the hook error.
 * @param child - The child node (test case or suite)
 * @param result - The adapter result to accumulate into
 * @param parentSuiteFailed - Whether an ancestor suite failed (e.g. hook timeout)
 */
function collectChildResults(child: TestCase | TestSuite, result: AdapterResult, parentSuiteFailed = false): void {
  if (child.type === 'test') {
    const testResult = child.result();

    if (testResult.state === 'passed') {
      result.passed++;
    } else if (testResult.state === 'failed') {
      result.failed++;

      const firstError = testResult.errors[0];
      const message = firstError?.message?.split('//')[0] ?? 'Unknown error';
      const { file, line } = firstError ? parseStackLocation(firstError) : {};

      result.errors.push({
        test: child.name,
        message,
        file,
        line,
      });
    } else if (testResult.state === 'skipped') {
      if (parentSuiteFailed) {
        // Hook failure caused this skip — count as failure
        result.failed++;
        result.errors.push({
          test: child.name,
          message: 'Skipped due to hook failure in parent suite',
        });
      } else {
        result.skipped++;
      }
    }
  } else {
    const suiteState = child.state();
    const suiteFailed = parentSuiteFailed || suiteState === 'failed';
    for (const suiteChild of child.children.array()) {
      collectChildResults(suiteChild, result, suiteFailed);
    }
  }
}

/**
 * Recursively collects schema violations from test task console logs.
 * @param child - Test case or suite node
 * @param result - Adapter result to accumulate violations into
 * @param seen - Set of already-seen violation keys for O(1) deduplication
 */
function collectViolationsFromTask(child: TestCase | TestSuite, result: AdapterResult, seen: Set<string>): void {
  const task = (child as { task?: InternalVitestTask }).task;
  if (task?.logs?.length) {
    const violations = parseViolationsFromLogs(task.logs);
    for (const v of violations) {
      const key = schemaViolationDedupKey(v);
      if (!seen.has(key)) {
        seen.add(key);
        result.schemaViolations.push(v);
      }
    }
  }
  if (child.type === 'suite') {
    for (const suiteChild of child.children.array()) {
      collectViolationsFromTask(suiteChild, result, seen);
    }
  }
}
