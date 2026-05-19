import { afterEach, describe, expect, it, mock } from 'bun:test';
import { waitFor } from '@makaio/test-utils';
import { createBusInstance } from '@makaio/bus-core';
import { ClaudeCodeClientSubjects } from '@makaio/client-claude-code/runtime';
import type { OutputWriter } from '@makaio/kernel/cli';
import { runClaudeStatuslineCommand, type ClaudeStatuslineCommandContext } from '../cli/handler.js';

const stdoutChunks: string[] = [];
const stderrChunks: string[] = [];

const validStatuslinePayload = {
  cwd: '/repo',
  session_id: 'session-1',
  transcript_path: '/repo/.claude/transcript.jsonl',
  model: {
    id: 'claude-sonnet-4',
    display_name: 'Sonnet',
  },
  workspace: {
    current_dir: '/repo',
    project_dir: '/repo',
    added_dirs: [],
  },
  version: '2.1.90',
  output_style: {
    name: 'default',
  },
  cost: {
    total_cost_usd: 0,
    total_duration_ms: 0,
    total_api_duration_ms: 0,
    total_lines_added: 0,
    total_lines_removed: 0,
  },
  context_window: {
    total_input_tokens: 0,
    total_output_tokens: 0,
    context_window_size: 200_000,
  },
  exceeds_200k_tokens: false,
} as const;

afterEach(() => {
  stdoutChunks.length = 0;
  stderrChunks.length = 0;
});

function createOutput(): OutputWriter {
  return {
    write(text) {
      stdoutChunks.push(text);
    },
    error(text) {
      stderrChunks.push(text);
    },
  };
}

function createContext(
  overrides: Partial<ClaudeStatuslineCommandContext> = {},
): ClaudeStatuslineCommandContext & { readonly setExitCodeSpy: ReturnType<typeof mock> } {
  const setExitCodeSpy = mock<(code: number) => void>();

  return {
    args: {},
    bus: {
      emit: mock(async () => undefined),
    },
    output: createOutput(),
    setExitCode: setExitCodeSpy,
    ...overrides,
    setExitCodeSpy,
  };
}

describe('runClaudeStatuslineCommand', () => {
  it('best-effort emits parsed JSON and preserves upstream stdout', async () => {
    const bus = createBusInstance();
    const receivedPayloads: Array<Record<string, unknown>> = [];
    const cleanup = bus.on(ClaudeCodeClientSubjects.statusline.received, ({ payload }) => {
      receivedPayloads.push(payload);
    });

    let upstreamInput = '';
    let upstreamCommand = '';
    let upstreamArgs: readonly string[] = [];

    await runClaudeStatuslineCommand(
      createContext({
        bus,
        args: {
          upstreamCommand: 'node',
          upstreamArgsJson: '["--example"]',
        },
      }),
      {
        readStdinText: async () => `${JSON.stringify(validStatuslinePayload)}\n`,
        runUpstream: async (request) => {
          upstreamInput = request.stdinText;
          upstreamCommand = request.command;
          upstreamArgs = request.args;
          request.onStdout('rendered-statusline');
        },
      },
    );

    cleanup();

    expect(receivedPayloads).toEqual([validStatuslinePayload]);
    expect(upstreamInput).toBe(`${JSON.stringify(validStatuslinePayload)}\n`);
    expect(upstreamCommand).toBe('node');
    expect(upstreamArgs).toEqual(['--example']);
    expect(stdoutChunks.join('')).toBe('rendered-statusline');
    expect(stderrChunks.join('')).toBe('');
  });

  it('keeps forwarding stdin when JSON parsing fails', async () => {
    const emit = mock(async () => undefined);
    let upstreamInput = '';

    await runClaudeStatuslineCommand(
      createContext({
        bus: { emit },
        args: {
          upstreamCommand: 'node',
        },
      }),
      {
        readStdinText: async () => 'not-json',
        runUpstream: async (request) => {
          upstreamInput = request.stdinText;
          request.onStdout('fallback-statusline');
        },
      },
    );

    expect(emit).not.toHaveBeenCalled();
    expect(upstreamInput).toBe('not-json');
    expect(stdoutChunks.join('')).toBe('fallback-statusline');
  });

  it('stays fail-open when bus emission or upstream arg parsing fails', async () => {
    const emit = mock(async () => {
      throw new Error('bus unavailable');
    });
    let upstreamArgs: readonly string[] | undefined;
    const ctx = createContext({
      bus: { emit },
      args: {
        upstreamCommand: 'node',
        upstreamArgsJson: '{"not":"an-array"}',
      },
    });

    await expect(
      runClaudeStatuslineCommand(ctx, {
        readStdinText: async () =>
          JSON.stringify({
            ...validStatuslinePayload,
            session_id: 'session-2',
          }),
        runUpstream: async (request) => {
          upstreamArgs = request.args;
        },
      }),
    ).resolves.toBeUndefined();

    expect(emit).toHaveBeenCalledWith(ClaudeCodeClientSubjects.statusline.received, {
      ...validStatuslinePayload,
      session_id: 'session-2',
    });
    expect(upstreamArgs).toEqual([]);
    expect(ctx.setExitCodeSpy).not.toHaveBeenCalled();
    expect(stdoutChunks.join('')).toBe('');
    expect(stderrChunks.join('')).toBe('');
  });

  it('stays fail-open when upstream execution fails', async () => {
    const emit = mock(async () => undefined);
    const ctx = createContext({
      bus: { emit },
      args: {
        upstreamCommand: 'node',
        upstreamArgsJson: '["--statusline"]',
      },
    });
    let upstreamCommand = '';
    let upstreamArgs: readonly string[] = [];

    await expect(
      runClaudeStatuslineCommand(ctx, {
        readStdinText: async () =>
          JSON.stringify({
            ...validStatuslinePayload,
            session_id: 'session-3',
          }),
        runUpstream: async (request) => {
          upstreamCommand = request.command;
          upstreamArgs = request.args;
          throw new Error('spawn failed');
        },
      }),
    ).resolves.toBeUndefined();

    expect(emit).toHaveBeenCalledWith(ClaudeCodeClientSubjects.statusline.received, {
      ...validStatuslinePayload,
      session_id: 'session-3',
    });
    expect(upstreamCommand).toBe('node');
    expect(upstreamArgs).toEqual(['--statusline']);
    expect(ctx.setExitCodeSpy).not.toHaveBeenCalled();
    expect(stdoutChunks.join('')).toBe('');
    expect(stderrChunks.join('')).toBe('');
  });

  it('skips bus emission and resolves when stdin is empty', async () => {
    const emit = mock(async () => undefined);
    const ctx = createContext({ bus: { emit } });

    await expect(
      runClaudeStatuslineCommand(ctx, {
        readStdinText: async () => '',
        runUpstream: async () => undefined,
      }),
    ).resolves.toBeUndefined();

    expect(emit).not.toHaveBeenCalled();
  });

  it('skips bus emission and resolves when stdin is whitespace-only', async () => {
    const emit = mock(async () => undefined);
    const ctx = createContext({ bus: { emit } });

    await expect(
      runClaudeStatuslineCommand(ctx, {
        readStdinText: async () => '  \n  ',
        runUpstream: async () => undefined,
      }),
    ).resolves.toBeUndefined();

    expect(emit).not.toHaveBeenCalled();
  });

  it('waits for bus emission before resolving when no upstream renderer is configured', async () => {
    let resolveEmit: (() => void) | undefined;
    let commandResolved = false;

    const emit = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveEmit = resolve;
        }),
    );

    const commandPromise = runClaudeStatuslineCommand(
      createContext({
        bus: { emit },
      }),
      {
        readStdinText: async () => JSON.stringify(validStatuslinePayload),
        runUpstream: async () => undefined,
      },
    ).then(() => {
      commandResolved = true;
    });

    await waitFor(() => expect(emit).toHaveBeenCalled());
    expect(commandResolved).toBe(false);

    resolveEmit?.();
    await commandPromise;

    expect(commandResolved).toBe(true);
  });

  it('does not wait for bus emission before running the upstream renderer', async () => {
    let resolveEmit: (() => void) | undefined;
    let upstreamRan = false;

    const emit = mock(
      () =>
        new Promise<void>((resolve) => {
          resolveEmit = resolve;
        }),
    );

    const commandPromise = runClaudeStatuslineCommand(
      createContext({
        bus: { emit },
        args: {
          upstreamCommand: 'node',
        },
      }),
      {
        readStdinText: async () => JSON.stringify(validStatuslinePayload),
        runUpstream: async (request) => {
          upstreamRan = true;
          request.onStdout('upstream-ran');
        },
      },
    );

    await waitFor(() => expect(upstreamRan).toBe(true));
    expect(upstreamRan).toBe(true);
    expect(stdoutChunks.join('')).toBe('upstream-ran');
    resolveEmit?.();
    await commandPromise;
  });
});
