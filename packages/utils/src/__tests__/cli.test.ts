import { describe, expect, it } from 'vitest';
import { CLI_EXIT_CODES, classifyCliCommandError } from '../cli.js';

describe('CLI utilities', () => {
  it('exposes stable CLI exit codes', () => {
    expect(CLI_EXIT_CODES).toEqual({
      failure: 1,
      timeout: 124,
      abort: 130,
    });
  });

  it('classifies bus abort and timeout errors by stable error name', () => {
    const abort = new Error('aborted');
    abort.name = 'OnceAbortError';
    const timeout = new Error('timed out');
    timeout.name = 'OnceTimeoutError';

    expect(classifyCliCommandError(abort)).toBe('abort');
    expect(classifyCliCommandError(timeout)).toBe('timeout');
  });

  it('classifies unknown errors as generic failures', () => {
    expect(classifyCliCommandError(new Error('boom'))).toBe('failure');
    expect(classifyCliCommandError('boom')).toBe('failure');
  });
});
