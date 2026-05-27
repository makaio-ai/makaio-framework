import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { IMakaioBus } from '@makaio/bus-core';
import type { CommandContext } from '@makaio/kernel/cli';
import { handlePrompt, type PromptArgs, PromptArgsSchema } from './prompt-command.js';

function stubPipedStdin(): () => void {
  const stdin = new PassThrough();
  Object.defineProperty(stdin, 'isTTY', { value: false });
  const spy = vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin);
  return () => {
    stdin.destroy();
    spy.mockRestore();
  };
}

describe('handlePrompt', () => {
  it('preserves signal-specific exit codes when piped stdin aborts', async () => {
    const restore = stubPipedStdin();
    const controller = new AbortController();
    const setExitCode = vi.fn<(code: number) => void>();
    const output = {
      write: vi.fn<(text: string) => void>(),
      error: vi.fn<(text: string) => void>(),
    };
    const ctx: CommandContext<PromptArgs> = {
      args: PromptArgsSchema.parse({}),
      bus: {} as IMakaioBus,
      output,
      signal: controller.signal,
      setExitCode,
    };

    try {
      const run = handlePrompt(ctx);
      controller.abort('SIGTERM');
      await run;

      expect(setExitCode).toHaveBeenCalledWith(143);
      expect(output.error).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
