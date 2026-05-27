import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  CLI_COMMAND_ABORT_SIGNALS,
  CLI_COMMAND_SIGNAL_EXIT_CODES,
  CLI_EXIT_CODES,
  classifyCliCommandError,
  readStdin,
  resolveCliSignalExitCode,
} from '../cli.js';

describe('CLI utilities', () => {
  it('exposes stable CLI exit codes', () => {
    expect(CLI_EXIT_CODES).toEqual({
      failure: 1,
      timeout: 124,
      abort: 130,
    });
  });

  it('exposes cooperative command signal exit codes', () => {
    expect(CLI_COMMAND_ABORT_SIGNALS).toEqual(['SIGINT', 'SIGTERM', 'SIGHUP']);
    expect(CLI_COMMAND_SIGNAL_EXIT_CODES).toEqual({
      SIGINT: 130,
      SIGTERM: 143,
      SIGHUP: 129,
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

  it('resolves signal abort reasons to signal-specific exit codes', () => {
    expect(resolveCliSignalExitCode('SIGINT')).toBe(130);
    expect(resolveCliSignalExitCode('SIGTERM')).toBe(143);
    expect(resolveCliSignalExitCode('SIGHUP')).toBe(129);
    expect(resolveCliSignalExitCode('other')).toBeUndefined();
    expect(resolveCliSignalExitCode('toString')).toBeUndefined();
  });

  it('aborts piped stdin reads when the command signal aborts', async () => {
    const stdin = new PassThrough();
    Object.defineProperty(stdin, 'isTTY', { value: false });
    const restore = vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
    const controller = new AbortController();

    try {
      const readPromise = readStdin(controller.signal);
      controller.abort('SIGTERM');

      await expect(readPromise).rejects.toMatchObject({ name: 'OnceAbortError', message: 'SIGTERM' });
    } finally {
      restore.mockRestore();
    }
  });
});
