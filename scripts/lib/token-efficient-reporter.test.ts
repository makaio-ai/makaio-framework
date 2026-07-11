import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
