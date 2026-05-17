import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TokenEfficientReporter from './token-efficient-reporter.js';

describe('TokenEfficientReporter', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
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

  it('clears stale command-under-test exit codes after a clean run', () => {
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    process.exitCode = 1;

    const reporter = new TokenEfficientReporter();
    reporter.onTestRunEnd([], [], 'passed');

    expect(process.exitCode).toBe(0);
  });

  it('keeps the final process exit status clean when a later hook dirties it', () => {
    const script = `
      import TokenEfficientReporter from './framework/scripts/lib/token-efficient-reporter.ts';
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
