import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import type { CommandContext } from '@makaio/kernel/cli';
import { SessionStorageSubjects, SessionSubjects } from '@makaio/contracts';
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

  it('aborts a pending sendMessage request with the command signal', async () => {
    const bus = createBusInstance();
    let resolveSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolveStarted) => {
      resolveSendStarted = resolveStarted;
    });
    let requestSignal: AbortSignal | undefined;
    const cleanupSend = bus.on(SessionSubjects.sendMessage, async (busCtx) => {
      requestSignal = busCtx.signal;
      resolveSendStarted();
      await new Promise(() => undefined);
    });
    const controller = new AbortController();
    const setExitCode = vi.fn<(code: number) => void>();
    const output = {
      write: vi.fn<(text: string) => void>(),
      error: vi.fn<(text: string) => void>(),
    };
    const ctx: CommandContext<PromptArgs> = {
      args: PromptArgsSchema.parse({ prompt: 'hello' }),
      bus,
      output,
      signal: controller.signal,
      setExitCode,
    };

    try {
      const run = handlePrompt(ctx);
      await sendStarted;
      controller.abort('SIGTERM');
      await run;

      expect(requestSignal).toBe(controller.signal);
      expect(setExitCode).toHaveBeenCalledWith(143);
      expect(output.error).not.toHaveBeenCalled();
    } finally {
      cleanupSend();
    }
  });

  it('threads the command signal through approval setup requests', async () => {
    const bus = createBusInstance();
    const requestSignals: Array<AbortSignal | undefined> = [];
    let resolveSendStarted!: () => void;
    const sendStarted = new Promise<void>((resolveStarted) => {
      resolveSendStarted = resolveStarted;
    });
    const cleanups = [
      bus.on(SessionSubjects.get, (busCtx) => {
        requestSignals.push(busCtx.signal);
        busCtx.setResult({ session: null });
      }),
      bus.on(SessionSubjects.create, (busCtx) => {
        requestSignals.push(busCtx.signal);
        busCtx.setResult({ sessionId: busCtx.payload.sessionId ?? 'session-created' });
      }),
      bus.on(SessionStorageSubjects.update, (busCtx) => {
        requestSignals.push(busCtx.signal);
        busCtx.setResult({ success: true });
      }),
      bus.on(SessionSubjects.sendMessage, async (busCtx) => {
        requestSignals.push(busCtx.signal);
        resolveSendStarted();
        await new Promise(() => undefined);
      }),
    ];
    const controller = new AbortController();
    const setExitCode = vi.fn<(code: number) => void>();
    const output = {
      write: vi.fn<(text: string) => void>(),
      error: vi.fn<(text: string) => void>(),
    };
    const ctx: CommandContext<PromptArgs> = {
      args: PromptArgsSchema.parse({ prompt: 'hello', dangerouslySkipPermissions: true }),
      bus,
      output,
      signal: controller.signal,
      setExitCode,
    };

    try {
      const run = handlePrompt(ctx);
      await sendStarted;
      controller.abort('SIGHUP');
      await run;

      expect(requestSignals).toEqual([controller.signal, controller.signal, controller.signal, controller.signal]);
      expect(setExitCode).toHaveBeenCalledWith(129);
      expect(output.error).not.toHaveBeenCalled();
    } finally {
      for (const cleanup of cleanups) {
        cleanup();
      }
    }
  });
});
