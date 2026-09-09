import { type Reporter, type TestCase, type TestModule, TestRunEndReason } from 'vitest/node';
import type { TestError } from 'vitest';
import type { SerializedError } from '@vitest/utils';
import { stripVTControlCharacters } from 'node:util';

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
const STACK_FRAME_LIMIT = 6;

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

/**
 * Prefer parsed caller locations over dependency frames, falling back to native stacks.
 * @param error - Vitest's serialized error and optional parsed locations.
 * @param limit - Remaining frame budget for this part of the cause chain.
 * @returns Bounded frames with source locations when Vitest supplied them.
 */
function extractStackFrames(error: SerializedError, limit: number): string[] {
  if (!error.stacks?.length) return extractNativeStackFrames(error.stack, limit);
  const callers = error.stacks.filter((frame) => !/(?:^|[/\\])node_modules[/\\]|^node:/u.test(frame.file));
  return (callers.length ? callers : error.stacks)
    .slice(0, limit)
    .map((frame) => `at ${frame.file}:${frame.line}:${frame.column}${frame.method ? ` (${frame.method})` : ''}`);
}

/**
 * Walk the cause chain once; Vitest serialization preserves circular references.
 * @param error - The root diagnostic supplied by Vitest.
 * @returns Ordered diagnostics, including a marker for a circular cause.
 */
function collectErrorChain(error: SerializedError): SerializedError[] {
  const chain: SerializedError[] = [];
  const seen = new Set<SerializedError>();
  let current: SerializedError | undefined = error;
  while (current !== undefined) {
    if (seen.has(current)) {
      chain.push({ message: '[circular cause]' });
      break;
    }
    seen.add(current);
    chain.push(current);
    const cause: SerializedError | undefined = current.cause;
    if (cause === undefined) break;
    current = typeof cause === 'object' && cause !== null ? cause : { message: String(cause) };
  }
  return chain;
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

    // Vitest delivers unhandled diagnostics to reporters here, not through an onUnhandledError hook.
    if (unhandledErrors.length) {
      process.stderr.write(`${colors.red}UNHANDLED ERRORS:${colors.reset}\n`);
      for (const error of unhandledErrors) {
        this.printError(error);
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
          this.printError(error);
        }
        process.stderr.write('\n');
      }
    }
    return moduleErrorCount;
  }

  /**
   * Prints complete messages and Vitest's prepared diffs without expanding arbitrary error fields.
   * @param error - The test error to print.
   */
  private printError(error: SerializedError): void {
    const chain = collectErrorChain(error).map((diagnostic) => ({
      diagnostic,
      frames: extractStackFrames(diagnostic, STACK_FRAME_LIMIT),
      frameLimit: 0,
    }));
    let remainingFrames = STACK_FRAME_LIMIT;
    // Share slots by stack depth before printing: short stacks leave their unused slots available.
    // The first round preserves outer locations before any stack receives a second frame.
    for (let depth = 0; depth < STACK_FRAME_LIMIT && remainingFrames > 0; depth++) {
      for (const entry of chain) {
        if (entry.frames.length <= depth) continue;
        entry.frameLimit++;
        if (--remainingFrames === 0) break;
      }
    }
    for (const [index, { diagnostic, frames, frameLimit }] of chain.entries()) {
      this.printIndented(`${index ? 'Caused by: ' : ''}${(diagnostic.message ?? 'Unknown error').trimEnd()}`);
      if (typeof diagnostic.diff === 'string' && diagnostic.diff) {
        this.printIndented(diagnostic.diff.trimEnd());
      }
      for (const frame of frames.slice(0, frameLimit)) this.printIndented(frame);
    }
  }

  /**
   * Write a possibly multi-line diagnostic with stable indentation.
   * @param text - Diagnostic text to write.
   */
  private printIndented(text: string): void {
    const diagnostic = useColors ? text : stripVTControlCharacters(text);
    for (const line of diagnostic.split(/\r?\n/u)) {
      process.stderr.write(`  ${line}\n`);
    }
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
