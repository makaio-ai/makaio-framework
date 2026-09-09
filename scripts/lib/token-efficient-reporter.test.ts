import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processError } from '@vitest/utils/error';
import { parseStacktrace } from '@vitest/utils/source-map';
import type { SerializedError } from '@vitest/utils';
import TokenEfficientReporter from './token-efficient-reporter.js';

/** Minimal TestModule children stub — real modules always expose suite iteration. */
const noSuites = {
  *allSuites() {
    // no suites in this module mock
  },
};

describe('TokenEfficientReporter', () => {
  afterEach(() => {
    process.exitCode = undefined;
    delete process.env.MAKAIO_TEST_PROFILE;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('prints a bounded timing profile only when requested', () => {
    process.env.MAKAIO_TEST_PROFILE = '1';
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const reporter = new TokenEfficientReporter();

    for (let index = 0; index < 12; index++) {
      reporter.onTestCaseResult({
        fullName: `timed test ${index}`,
        result: () => ({ state: 'passed' }),
        diagnostic: () => ({ duration: index }),
      } as never);
    }
    reporter.onTestRunEnd(
      [
        ...Array.from(
          { length: 12 },
          (_, index) =>
            ({
              relativeModuleId: `src/timed-${index}.test.ts`,
              errors: () => [],
              children: noSuites,
              diagnostic: () => ({ duration: index }),
            }) as never,
        ),
        {
          relativeModuleId: 'src/setup-heavy.test.ts',
          errors: () => [],
          children: noSuites,
          diagnostic: () => ({ duration: 1, collectDuration: 20, setupDuration: 30 }),
        } as never,
      ],
      [],
      'passed',
    );

    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('Slowest test modules:');
    expect(output).toContain('51ms  src/setup-heavy.test.ts');
    expect(output).toContain('11ms  src/timed-11.test.ts');
    expect(output).toContain('11ms  timed test 11');
    expect(output).not.toContain('src/timed-0.test.ts');
    expect(output).not.toContain('timed test 0');
  });

  it('omits timing sections from ordinary output', () => {
    delete process.env.MAKAIO_TEST_PROFILE;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const reporter = new TokenEfficientReporter();

    reporter.onTestRunEnd([], [], 'passed');

    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).not.toContain('Slowest test modules:');
    expect(output).not.toContain('Slowest test cases:');
  });

  it.each([true, false])('retains complete failed-test diagnostics with AI_AGENT=%s', async (aiMode) => {
    vi.stubEnv('AI_AGENT', aiMode ? '1' : undefined);
    vi.stubEnv('NO_COLOR', '1');
    vi.resetModules();
    const { default: Reporter } = await import('./token-efficient-reporter.js');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const assertion = processError(
      Object.assign(new Error('Unexpected provider result\nThe worker did not start'), {
        actual: { state: 'failed', message: 'worker startup failed' },
        expected: { state: 'completed' },
        showDiff: true,
      }),
    );
    const failure = processError(
      new Error('Workload failed\nPreparation never completed', {
        cause: new Error('Provider refused startup\nInspect the invocation result', { cause: assertion }),
      }),
    );
    failure.stacks = parseStacktrace(
      [
        'Error: Workload failed',
        ...Array.from({ length: 8 }, (_, index) => `    at assert (/repo/node_modules/assert/frame-${index}.js:1:1)`),
        '    at waitForStart (/repo/src/wait.ts:12:4)',
        '    at testCase (/repo/src/worker.test.ts:42:7)',
      ].join('\n'),
      { ignoreStackEntries: [] },
    );
    const reporter = new Reporter();
    reporter.onTestCaseResult({
      fullName: 'worker startup',
      result: () => ({ state: 'failed', errors: [failure] }),
    } as never);

    const immediate = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(immediate.includes('Preparation never completed')).toBe(aiMode);
    reporter.onTestRunEnd([], [], 'failed');
    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output.match(/Preparation never completed/gu)).toHaveLength(1);
    expect(output).toContain('Caused by: Provider refused startup\n  Inspect the invocation result');
    expect(output).toContain('Caused by: Unexpected provider result\n  The worker did not start');
    expect(output).toContain('worker startup failed');
    expect(output).toContain('- Expected');
    expect(output).toContain('+ Received');
    expect(output).toContain('at /repo/src/wait.ts:12:4');
    expect(output).toContain('at /repo/src/worker.test.ts:42:7');
    expect(output).not.toContain('node_modules/assert');
    expect(stdout.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('1 failed');
  });

  it('terminates a serialized circular cause without dumping custom error properties', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const cause = new Error('Inner cause');
    const error = Object.assign(new Error('Outer failure', { cause }), { privateDiagnostic: 'not-for-output' });
    cause.cause = error;
    const serialized = processError(error);
    const reporter = new TokenEfficientReporter();

    reporter.onTestRunEnd([], [serialized], 'failed');

    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    // processError expands part of the chain before preserving the repeated reference.
    expect(output.match(/Caused by: Inner cause/gu)).toHaveLength(2);
    expect(output).toContain('Caused by: [circular cause]');
    expect(output).not.toContain('not-for-output');
    expect(output.match(/^ {2}at /gmu)?.length).toBeLessThanOrEqual(6);
  });

  it('retains primitive causes serialized by Vitest', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const reporter = new TokenEfficientReporter();

    reporter.onTestRunEnd([], [processError(new Error('Provider failed', { cause: 'ECONNRESET' }))], 'failed');

    expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join('')).toContain('Caused by: ECONNRESET');
  });

  it('keeps all six root frames when a primitive cause has no stack', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const error = new Error('Provider failed', { cause: 'ECONNRESET' });
    error.stack = [
      'Error: Provider failed',
      ...Array.from({ length: 7 }, (_, index) => `    at root${index} (worker.ts:${index + 1}:1)`),
    ].join('\n');

    new TokenEfficientReporter().onTestRunEnd([], [processError(error)], 'failed');

    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output.match(/^ {2}at /gmu)).toHaveLength(6);
    expect(output).toContain('at root5 (worker.ts:6:1)');
    expect(output).not.toContain('root6');
    expect(output).toContain('Caused by: ECONNRESET');
  });

  it('retains the outer location across a long chain of stackless causes', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let cause: SerializedError = { message: 'Innermost cause' };
    for (let index = 0; index < 8; index++) cause = { message: `Context ${index}`, cause };
    const error = {
      message: 'Outer failure',
      stack: 'Error: Outer failure\n    at testCase (worker.test.ts:42:7)',
      cause,
    };

    new TokenEfficientReporter().onTestRunEnd([], [error], 'failed');

    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('at testCase (worker.test.ts:42:7)');
    expect(output).toContain('Caused by: Innermost cause');
    expect(output.match(/Caused by: Context/gu)).toHaveLength(8);
    expect(output.match(/^ {2}at /gmu)).toHaveLength(1);
  });

  it.each([
    { rootFrames: 7, causeFrames: 1, stacklessMiddle: false, rootShown: 5, causeShown: 1 },
    { rootFrames: 7, causeFrames: 1, stacklessMiddle: true, rootShown: 5, causeShown: 1 },
    { rootFrames: 1, causeFrames: 7, stacklessMiddle: false, rootShown: 1, causeShown: 5 },
  ])('redistributes unused frame slots for $rootFrames/$causeFrames frames, stackless middle=$stacklessMiddle', (testCase) => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const cause: SerializedError = {
      message: 'Cause failed',
      stack: Array.from({ length: testCase.causeFrames }, (_, index) => `    at cause${index} (cause.ts:1:1)`).join(
        '\n',
      ),
    };
    const error: SerializedError = {
      message: 'Root failed',
      stack: Array.from({ length: testCase.rootFrames }, (_, index) => `    at root${index} (root.ts:1:1)`).join('\n'),
      cause: testCase.stacklessMiddle ? { message: 'Intermediate context', cause } : cause,
    };

    new TokenEfficientReporter().onTestRunEnd([], [error], 'failed');

    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output.match(/^ {2}at /gmu)).toHaveLength(6);
    expect(output.match(/^ {2}at root/gmu)).toHaveLength(testCase.rootShown);
    expect(output.match(/^ {2}at cause/gmu)).toHaveLength(testCase.causeShown);
    expect(output).toContain(`at root${testCase.rootShown - 1} (root.ts:1:1)`);
    expect(output).toContain(`at cause${testCase.causeShown - 1} (cause.ts:1:1)`);
    expect(output.indexOf('at root0')).toBeLessThan(output.indexOf('Caused by:'));
    expect(output.includes('Caused by: Intermediate context')).toBe(testCase.stacklessMiddle);
  });

  it('preserves the first six locations when more than six diagnostics have stacks', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let error: SerializedError = { message: 'Failure 7', stack: 'Error: Failure 7\n    at frame7 (worker.ts:1:1)' };
    for (let index = 6; index >= 0; index--) {
      error = {
        message: `Failure ${index}`,
        stack: `Error: Failure ${index}\n    at frame${index} (worker.ts:1:1)`,
        cause: error,
      };
    }

    new TokenEfficientReporter().onTestRunEnd([], [error], 'failed');

    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output.match(/^ {2}at /gmu)).toHaveLength(6);
    expect(output).toContain('at frame0 (worker.ts:1:1)');
    expect(output).toContain('at frame5 (worker.ts:1:1)');
    expect(output).not.toContain('at frame6');
    expect(output).toContain('Caused by: Failure 7');
  });

  it('strips ANSI formatting from supplied diffs when colors are disabled', async () => {
    vi.stubEnv('AI_AGENT', '1');
    vi.resetModules();
    const { default: Reporter } = await import('./token-efficient-reporter.js');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const reporter = new Reporter();
    reporter.onTestCaseResult({
      fullName: 'colored assertion',
      result: () => ({
        state: 'failed',
        errors: [{ message: 'Mismatch', diff: '\x1b[31m- expected\x1b[0m\n+ received' }],
      }),
    } as never);

    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('  - expected\n  + received');
    expect(output).not.toContain('\x1b');
  });

  it.each(['NO_COLOR', 'AI_AGENT'])('strips supplied ANSI from unhandled diagnostics with %s', async (colorSetting) => {
    vi.stubEnv('NO_COLOR', undefined);
    vi.stubEnv('AI_AGENT', undefined);
    vi.stubEnv(colorSetting, '1');
    vi.resetModules();
    const { default: Reporter } = await import('./token-efficient-reporter.js');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    new Reporter().onTestRunEnd(
      [],
      [
        {
          message: '\x1b[31mWorker failed\x1b[0m\nStartup was interrupted',
          diff: '\x1b[32m- expected\x1b[0m\n+ received',
          cause: { message: '\x1b[33mProvider refused startup\x1b[0m' },
        },
      ],
      'failed',
    );

    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('UNHANDLED ERRORS:');
    expect(output).toContain('  Worker failed\n  Startup was interrupted');
    expect(output).toContain('  - expected\n  + received');
    expect(output).toContain('Caused by: Provider refused startup');
    expect(output).not.toContain('\x1b');
  });

  it('prints multi-line module error diagnostics', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const reporter = new TokenEfficientReporter();
    reporter.onTestRunEnd(
      [
        {
          relativeModuleId: 'src/broken.test.ts',
          errors: () => [
            {
              message: [
                'Transform failed with 1 error:',
                '',
                '[PARSE_ERROR] Error: Missing catch or finally clause',
                'Help: Either unwrap this try block or add catch / finally clause',
              ].join('\n'),
            },
          ],
          children: { *allSuites() {} },
        } as never,
      ],
      [],
      'failed',
    );

    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    const summary = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');

    expect(output).toContain('MODULE ERROR');
    expect(output).toContain('[PARSE_ERROR] Error: Missing catch or finally clause');
    expect(output).toContain('Help: Either unwrap this try block or add catch / finally clause');
    expect(summary).toContain('1 module error');
    expect(summary).toContain('(1 total)');
  });

  it('prints suite-level errors such as a failing beforeAll hook', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const reporter = new TokenEfficientReporter();
    reporter.onTestRunEnd(
      [
        {
          relativeModuleId: 'src/hook.test.ts',
          errors: () => [],
          children: {
            *allSuites() {
              yield {
                fullName: 'outer > suite with broken hook',
                errors: () => [{ message: 'beforeAll exploded' }],
              };
            },
          },
        } as never,
      ],
      [],
      'failed',
    );

    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    const summary = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');

    expect(output).toContain('MODULE ERROR');
    expect(output).toContain('src/hook.test.ts > outer > suite with broken hook');
    expect(output).toContain('beforeAll exploded');
    expect(summary).toContain('1 module error');
  });

  it('prints bounded native stacks for worker-style unhandled errors without repeating messages', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const reporter = new TokenEfficientReporter();

    reporter.onTestRunEnd(
      [],
      [
        {
          message: '[vitest-pool]: Worker threads emitted error.',
          stack: [
            'Error: [vitest-pool]: Worker threads emitted error.',
            '    at Pool.schedule (pool.ts:1:1)',
            '    at Pool.run (pool.ts:2:1)',
            '    at Pool.frameThree (pool.ts:3:1)',
            '    at Pool.frameFour (pool.ts:4:1)',
            '    at Pool.frameFive (pool.ts:5:1)',
            '    at Pool.frameSix (pool.ts:6:1)',
          ].join('\n'),
          cause: {
            message: 'Bad control character in string literal',
            stack: [
              'SyntaxError: Bad control character in string literal',
              '    at JSON.parse (<anonymous>)',
              '    at loadConfig (worker.ts:2:1)',
              '    at frameThree (worker.ts:3:1)',
              '    at frameFour (worker.ts:4:1)',
              '    at frameFive (worker.ts:5:1)',
              '    at frameSix (worker.ts:6:1)',
              '    at omittedFrame (worker.ts:7:1)',
            ].join('\n'),
          },
        },
      ],
      'failed',
    );

    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output.match(/\[vitest-pool\]: Worker threads emitted error\./gu)).toHaveLength(1);
    expect(output.match(/Bad control character in string literal/gu)).toHaveLength(1);
    expect(output).toContain('at Pool.schedule (pool.ts:1:1)');
    expect(output).toContain('at Pool.frameThree (pool.ts:3:1)');
    expect(output).not.toContain('at Pool.frameFour (pool.ts:4:1)');
    expect(output).toContain('at JSON.parse (<anonymous>)');
    expect(output).toContain('at frameThree (worker.ts:3:1)');
    expect(output).not.toContain('at frameFour (worker.ts:4:1)');
    expect(output).not.toContain('omittedFrame');
  });

  it('prefers the parsed root location while retaining the native cause stack', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const reporter = new TokenEfficientReporter();

    reporter.onTestRunEnd(
      [],
      [
        {
          message: 'Import failed',
          stacks: [{ method: 'load', file: 'src/broken.ts', line: 42, column: 7 }],
          stack: 'Error: Import failed\n    at nativeLocation (native.ts:1:1)',
          cause: {
            message: 'Parse failed',
            stack: 'SyntaxError: Parse failed\n    at nativeCause (cause.ts:2:1)',
          },
        },
      ],
      'failed',
    );

    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(output).toContain('at src/broken.ts:42');
    expect(output).not.toContain('nativeLocation');
    expect(output).toContain('at nativeCause (cause.ts:2:1)');
  });

  it('clears stale command-under-test exit codes after a clean run', () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.exitCode = 1;

    const reporter = new TokenEfficientReporter();
    reporter.onTestRunEnd([], [], 'passed');

    expect(process.exitCode).toBe(0);
  });

  it('keeps the final process exit status clean when a later hook dirties it', () => {
    const reporterUrl = new URL('./token-efficient-reporter.ts', import.meta.url).href;
    const script = `
      import TokenEfficientReporter from ${JSON.stringify(reporterUrl)};
      const reporter = new TokenEfficientReporter();
      reporter.onInit();
      process.stdout.write = () => true;
      process.stderr.write = () => true;
      reporter.onTestRunEnd([], [], 'passed');
      process.exitCode = 1;
    `;

    expect(() =>
      execFileSync(process.execPath, ['--import', 'tsx', '--eval', script], {
        cwd: process.cwd(),
        stdio: 'pipe',
      }),
    ).not.toThrow();
  }, 30000);
});
