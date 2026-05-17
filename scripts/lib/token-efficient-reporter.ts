import { type Reporter, type TestCase, type TestModule, TestRunEndReason } from 'vitest/node';
import type { TestError } from 'vitest';
import { SerializedError } from '@vitest/utils';

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

interface PrintErrorOptions {
  /** Print the complete multi-line error message instead of the first line only. */
  fullMessage?: boolean;
}

export default class TokenEfficientReporter implements Reporter {
  private lastColor: string | null = null;
  private counts = { passed: 0, failed: 0, skipped: 0 };
  private failedTests: FailedTest[] = [];
  private cleanRunOwnsExitCode = false;

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

    // Print module-level errors (e.g., import failures)
    let moduleErrorCount = 0;
    for (const testModule of testModules) {
      const moduleErrors = testModule.errors();
      if (moduleErrors?.length) {
        moduleErrorCount += moduleErrors.length;
        process.stderr.write(`${colors.red}MODULE ERROR:${colors.reset} ${testModule.relativeModuleId}\n`);
        for (const error of moduleErrors) {
          this.printError(error as TestError, { fullMessage: true });
        }
        process.stderr.write('\n');
      }
    }

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
   * Prints an error with its message, cause chain, and stack location.
   * @param error - The test error to print.
   * @param options - Formatting options for diagnostics with multi-line payloads.
   */
  private printError(error: TestError, options: PrintErrorOptions = {}): void {
    const rawMessage = error.message ?? 'Unknown error';
    const message = options.fullMessage ? rawMessage.trimEnd() : (rawMessage.split('\n')[0] ?? 'Unknown error');
    this.printIndented(message);

    // Print cause chain if present (e.g., import errors have nested causes)
    const cause = (error as TestError & { cause?: { message?: string } }).cause;
    if (cause?.message) {
      const causeMessage = options.fullMessage ? cause.message.trimEnd() : cause.message.split('\n')[0];
      this.printIndented(`Caused by: ${causeMessage}`);
    }

    const stack = error.stacks?.[0];
    if (stack) {
      process.stderr.write(`  at ${stack.file}:${stack.line}\n`);
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
}
