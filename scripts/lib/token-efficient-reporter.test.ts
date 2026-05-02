import { afterEach, describe, expect, it, vi } from 'vitest';
import TokenEfficientReporter from './token-efficient-reporter.js';

describe('TokenEfficientReporter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints multi-line module error diagnostics', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

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
      undefined as never,
    );

    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('');

    expect(output).toContain('MODULE ERROR');
    expect(output).toContain('[PARSE_ERROR] Error: Missing catch or finally clause');
    expect(output).toContain('Help: Either unwrap this try block or add catch / finally clause');
  });
});
