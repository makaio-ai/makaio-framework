import { type Reporter, type TestCase, type TestModule, TestRunEndReason } from 'vitest/node';
import type { TestError } from 'vitest';
import type { SerializedError } from '@vitest/utils';

/**
 * Token-efficient test reporter for AI consumption.
 *
 * Key optimizations:
 * - Uses '+' for pass, 'x' for fail, '-' for skip
 * - Respects NO_COLOR and AI_AGENT env vars to disable ANSI codes
 * - Batches output for minimal token overhead
 */

// Respect NO_COLOR standard (https://no-color.org/) and AI_AGENT env var
// Use 'in' operator to check presence, not value - empty string should disable colors per spec
const useColors = !('NO_COLOR' in process.env) && !('AI_AGENT' in process.env);

/** When true, suppress per-test progress chars and only report failures + summary. */
const aiAgent = 'AI_AGENT' in process.env;

const colors = useColors
  ? {
      green: '\x1b[32m',
      red: '\x1b[31m',
      yellow: '\x1b[33m',
      reset: '\x1b[0m',
    }
  : {
      green: '',
      red: '',
      yellow: '',
      reset: '',
    };

type TestState = 'passed' | 'failed' | 'skipped';

interface StateConfig {
  char: string;
  color: string;
  stream: NodeJS.WriteStream;
}

const stateConfig: Record<TestState, StateConfig> = {
  passed: { char: '+', color: colors.green, stream: process.stdout },
  failed: { char: 'x', color: colors.red, stream: process.stderr },
  skipped: { char: '-', color: colors.yellow, stream: process.stdout },
};

interface FailedTest {
  name: string;
  errors: readonly TestError[];
}

interface TimedTest {
  name: string;
  duration: number;
}

/** Timing phases reported independently by Vitest for one test module. */
interface ModuleTimingDiagnostic {
  duration?: number;
  environmentSetupDuration?: number;
  prepareDuration?: number;
  collectDuration?: number;
  setupDuration?: number;
}

const TIMING_PROFILE_LIMIT = 10;
const NATIVE_STACK_FRAME_LIMIT = 6;

interface PrintErrorOptions {
  /** Print the complete multi-line error message instead of the first line only. */
  fullMessage?: boolean;
}

/**
 * Extract bounded V8 stack frames without repeating the error's message header.
 * @param stack - Native serialized stack string.
 * @param limit - Maximum number of frames to return.
 * @returns At most `limit` normalized stack frames.
 */
function extractNativeStackFrames(stack: string | undefined, limit: number): string[] {
  if (stack === undefined) return [];
  return stack
    .split(/\r?\n/u)
    .filter((line) => /^\s*at\s+/u.test(line))
    .slice(0, limit)
    .map((line) => line.trimStart());
}

export default class TokenEfficientReporter implements Reporter {
  private lastColor: string | null = null;
  private counts = { passed: 0, failed: 0, skipped: 0 };
  private failedTests: FailedTest[] = [];
  private slowestTests: TimedTest[] = [];
  private cleanRunOwnsExitCode = false;
  private readonly timingProfileEnabled = 'MAKAIO_TEST_PROFILE' in process.env;

  public onInit(): void {
    process.once('exit', () => {
      if (this.cleanRunOwnsExitCode) {
        process.exitCode = 0;
      }
    });
  }

  public onTestRunStart(): void {
    if (aiAgent) {
      process.stderr.write('AI-optimized output: only failures will be shown. Wait up to 20 minutes.\n');
    }
  }

  public onUserConsoleLog(log: { content: string; type: 'stdout' | 'stderr' }): void {
    // Suppress vitest's default console log forwarding unless MAKAIO_DEBUG is set.
    if (process.env.MAKAIO_DEBUG) {
      const stream = log.type === 'stderr' ? process.stderr : process.stdout;
      stream.write(log.content);
    }
  }

  public onTestCaseResult(testCase: TestCase): void {
    const result = testCase.result();
    const state = result.state as TestState;
    if (!(state in stateConfig)) return;

    if (this.timingProfileEnabled) {
      const duration = testCase.diagnostic()?.duration;
      if (duration !== undefined) {
        this.recordSlowTest({ name: testCase.fullName, duration });
      }
    }

    const config = stateConfig[state];
    this.counts[state]++;

    // Capture failure details — the array is used both for immediate streaming
    // in AI mode and for the end-of-run recap in normal mode.
    if (state === 'failed' && result.errors?.length) {
      const failure: FailedTest = { name: testCase.fullName, errors: result.errors };
      this.failedTests.push(failure);

      // In AI mode, stream failure details immediately so the agent doesn't
      // have to wait for the full suite to finish before seeing what broke.
      if (aiAgent) {
        process.stderr.write(`\n${colors.red}FAIL${colors.reset} ${failure.name}\n`);
        for (const error of failure.errors) {
          this.printError(error);
        }
        return;
      }
    }

    // In AI mode, only emit chars for failures — passes and skips are noise
    if (aiAgent) return;

    // Only emit color code when it changes
    if (config.color !== this.lastColor) {
      config.stream.write(config.color);
      this.lastColor = config.color;
    }
    config.stream.write(config.char);
  }

  public onTestRunEnd(
    testModules: ReadonlyArray<TestModule>,
    unhandledErrors: ReadonlyArray<SerializedError>,
    reason: TestRunEndReason,
  ): void {
    // Reset colors and print summary
    process.stdout.write(colors.reset + '\n\n');

    // In AI mode failures were already streamed inline; skip the recap.
    if (!aiAgent && this.failedTests.length) {
      process.stderr.write(`${colors.red}FAILURES:${colors.reset}\n`);
      for (const { name, errors } of this.failedTests) {
        process.stderr.write(`\n${colors.red}✗${colors.reset} ${name}\n`);
        for (const error of errors) {
          this.printError(error);
        }
      }
      process.stderr.write('\n');
    }

    const moduleErrorCount = this.printModuleAndSuiteErrors(testModules);

    // Print unhandled errors collected during the run
    if (unhandledErrors.length) {
      process.stderr.write(`${colors.red}UNHANDLED ERRORS:${colors.reset}\n`);
      for (const error of unhandledErrors) {
        this.printError(error as TestError, { fullMessage: true });
      }
      process.stderr.write('\n');
    }

    const { passed, failed, skipped } = this.counts;
    const total = passed + failed + skipped + moduleErrorCount;

    const parts: string[] = [];
    if (passed) parts.push(`${colors.green}${passed} passed${colors.reset}`);
    if (failed) parts.push(`${colors.red}${failed} failed${colors.reset}`);
    if (skipped) parts.push(`${colors.yellow}${skipped} skipped${colors.reset}`);
    if (moduleErrorCount) {
      const label = moduleErrorCount === 1 ? 'module error' : 'module errors';
      parts.push(`${colors.red}${moduleErrorCount} ${label}${colors.reset}`);
    }

    process.stdout.write(`${parts.join(' | ')} (${total} total)\n`);

    this.printTimingProfile(testModules);

    // CLI-oriented tests intentionally assert non-zero process.exitCode values.
    // A clean Vitest result must own the final process status instead of
    // inheriting a stale command-under-test exit code from the worker lifecycle.
    this.cleanRunOwnsExitCode =
      reason === 'passed' && failed === 0 && moduleErrorCount === 0 && unhandledErrors.length === 0;
    if (this.cleanRunOwnsExitCode) {
      process.exitCode = 0;
    }
  }

  /**
   * Prints module-level errors (e.g., import failures) and suite-level errors
   * (e.g., a failing beforeAll inside a describe). Suite errors attach to the
   * TestSuite, not the TestModule — without walking the suites a failed hook
   * would fail the run with no error text at all.
   * @param testModules - The test modules reported for this run.
   * @returns The total number of module- and suite-level errors printed.
   */
  private printModuleAndSuiteErrors(testModules: ReadonlyArray<TestModule>): number {
    let moduleErrorCount = 0;
    for (const testModule of testModules) {
      const scopes: { label: string; errors: readonly SerializedError[] }[] = [
        { label: testModule.relativeModuleId, errors: testModule.errors() },
      ];
      for (const suite of testModule.children.allSuites()) {
        scopes.push({ label: `${testModule.relativeModuleId} > ${suite.fullName}`, errors: suite.errors() });
      }
      for (const { label, errors } of scopes) {
        if (!errors?.length) continue;
        moduleErrorCount += errors.length;
        process.stderr.write(`${colors.red}MODULE ERROR:${colors.reset} ${label}\n`);
        for (const error of errors) {
          this.printError(error as TestError, { fullMessage: true });
        }
        process.stderr.write('\n');
      }
    }
    return moduleErrorCount;
  }

  /**
   * Prints an error with its message, cause chain, and stack location.
   * @param error - The test error to print.
   * @param options - Formatting options for diagnostics with multi-line payloads.
   */
  private printError(error: SerializedError, options: PrintErrorOptions = {}): void {
    const rawMessage = error.message ?? 'Unknown error';
    const message = options.fullMessage ? rawMessage.trimEnd() : (rawMessage.split('\n')[0] ?? 'Unknown error');
    this.printIndented(message);

    // Print cause chain if present (e.g., import errors have nested causes)
    const cause = error.cause;
    if (cause?.message) {
      const causeMessage = options.fullMessage ? cause.message.trimEnd() : cause.message.split('\n')[0];
      this.printIndented(`Caused by: ${causeMessage}`);
    }

    const stack = error.stacks?.[0];
    if (stack) {
      process.stderr.write(`  at ${stack.file}:${stack.line}\n`);
      for (const frame of extractNativeStackFrames(cause?.stack, NATIVE_STACK_FRAME_LIMIT - 1)) {
        process.stderr.write(`  ${frame}\n`);
      }
      return;
    }

    const errorFrameLimit = cause?.stack === undefined ? NATIVE_STACK_FRAME_LIMIT : NATIVE_STACK_FRAME_LIMIT / 2;
    const errorFrames = extractNativeStackFrames(error.stack, errorFrameLimit);
    const causeFrames = extractNativeStackFrames(cause?.stack, NATIVE_STACK_FRAME_LIMIT - errorFrames.length);
    for (const frame of [...errorFrames, ...causeFrames]) {
      process.stderr.write(`  ${frame}\n`);
    }
  }

  /**
   * Write a possibly multi-line diagnostic with stable indentation.
   * @param text - Diagnostic text to write.
   */
  private printIndented(text: string): void {
    for (const line of text.split('\n')) {
      process.stderr.write(`  ${line}\n`);
    }
  }

  public onUnhandledError(error: unknown): void {
    const typed = error as TestError & { type?: string };
    const header = typed.type ? `${typed.type}: ${typed.name ?? 'Error'}` : (typed.name ?? 'Error');
    const message = typed.message ?? String(error);
    process.stderr.write(`${colors.red}UNHANDLED${colors.reset} ${header} - ${message}\n`);
  }

  /**
   * Retains only the slowest tests needed for the opt-in timing report.
   * @param test - Completed test timing.
   */
  private recordSlowTest(test: TimedTest): void {
    this.slowestTests.push(test);
    this.slowestTests.sort((left, right) => right.duration - left.duration);
    if (this.slowestTests.length > TIMING_PROFILE_LIMIT) {
      this.slowestTests.length = TIMING_PROFILE_LIMIT;
    }
  }

  /**
   * Prints the slowest modules and test cases without changing normal output.
   * @param testModules - Completed Vitest modules with timing diagnostics.
   */
  private printTimingProfile(testModules: ReadonlyArray<TestModule>): void {
    if (!this.timingProfileEnabled) return;

    const slowestModules = testModules
      .map((testModule) => ({
        name: testModule.relativeModuleId,
        duration: this.totalModuleDuration(testModule.diagnostic()),
      }))
      .filter((module): module is TimedTest => module.duration !== undefined)
      .sort((left, right) => right.duration - left.duration)
      .slice(0, TIMING_PROFILE_LIMIT);

    process.stdout.write('\nSlowest test modules:\n');
    for (const module of slowestModules) {
      process.stdout.write(`  ${module.duration.toFixed(0)}ms  ${module.name}\n`);
    }
    process.stdout.write('Slowest test cases:\n');
    for (const test of this.slowestTests) {
      process.stdout.write(`  ${test.duration.toFixed(0)}ms  ${test.name}\n`);
    }
  }

  /**
   * Sum Vitest's non-overlapping module phases into one profiling cost.
   * @param diagnostic - Vitest module timing diagnostic.
   * @returns Total measured module cost, or undefined when no phase was measured.
   */
  private totalModuleDuration(diagnostic: ModuleTimingDiagnostic | undefined): number | undefined {
    if (!diagnostic) return undefined;
    const phases = [
      diagnostic.environmentSetupDuration,
      diagnostic.prepareDuration,
      diagnostic.collectDuration,
      diagnostic.setupDuration,
      diagnostic.duration,
    ];
    const measuredPhases = phases.filter((duration): duration is number => duration !== undefined);
    return measuredPhases.length > 0 ? measuredPhases.reduce((total, duration) => total + duration, 0) : undefined;
  }
}
