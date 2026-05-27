/**
 * Unit tests for {@link registerContribution}.
 *
 * The interactive handler registered by `registerContribution` must only run
 * when both stdin and stdout are real TTYs. When either stream is piped or
 * redirected the guard must set `process.exitCode = 1` and return without
 * invoking the handler or using the bus.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import type { IMakaioBus } from '@makaio/bus-core';
import type { CliContribution, EmbeddedBusHandle } from '@makaio/kernel/cli';
import { createMockBus } from '@makaio/test-utils';
import { z } from 'zod';

import { registerContribution } from './schema-adapter.js';
import { createTestTTYFixture } from './test-tty-fixture.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal fake bus — enough to satisfy the IMakaioBus type in tests. */
const { bus: fakeBus } = createMockBus();

/**
 * Build a minimal {@link CliContribution} with an interactive handler for
 * testing, using the provided handler spy.
 * @param handler - The interactive handler to attach.
 */
function makeContribution(handler: (ctx: { bus: IMakaioBus | null }) => Promise<void>): CliContribution {
  return {
    name: 'test-cmd',
    description: 'A test command',
    interactive: handler,
    subcommands: [],
  };
}

/**
 * Create a fresh Commander program with `.exitOverride()` so that Commander
 * errors throw instead of calling `process.exit`.
 */
function makeProgram(): InstanceType<typeof Command> {
  return new Command().exitOverride();
}

// ---------------------------------------------------------------------------
// TTY guard tests
// ---------------------------------------------------------------------------

describe('registerContribution — interactive TTY guard', () => {
  const ttyFixture = createTestTTYFixture();

  beforeEach(() => {
    ttyFixture.snapshot();
    process.exitCode = undefined;
  });

  afterEach(() => {
    ttyFixture.restore();
    process.exitCode = undefined;
  });

  // -------------------------------------------------------------------------
  // Non-TTY (piped / redirected)
  // -------------------------------------------------------------------------

  describe('when stdin or stdout is NOT a TTY', () => {
    beforeEach(() => {
      ttyFixture.set({ stdoutIsTTY: false, stdinIsTTY: true });
    });

    it('does NOT invoke the interactive handler', async () => {
      const interactiveHandler = vi.fn(() => Promise.resolve());
      const program = makeProgram();
      registerContribution(program, makeContribution(interactiveHandler), fakeBus);

      await program.parseAsync(['test-cmd'], { from: 'user' });

      expect(interactiveHandler).not.toHaveBeenCalled();
    });

    it('sets process.exitCode to 1', async () => {
      const interactiveHandler = vi.fn(() => Promise.resolve());
      const program = makeProgram();
      registerContribution(program, makeContribution(interactiveHandler), fakeBus);

      await program.parseAsync(['test-cmd'], { from: 'user' });

      expect(process.exitCode).toBe(1);
    });

    it('writes a helpful error message to stderr', async () => {
      const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const program = makeProgram();
        registerContribution(
          program,
          makeContribution(() => Promise.resolve()),
          fakeBus,
        );

        await program.parseAsync(['test-cmd'], { from: 'user' });

        expect(stderrSpy).toHaveBeenCalledWith(
          expect.stringContaining("'makaio test-cmd' requires an interactive terminal"),
        );
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('guards when stdout isTTY is undefined (real pipe behavior)', async () => {
      ttyFixture.set({ stdoutIsTTY: undefined });
      const interactiveHandler = vi.fn(() => Promise.resolve());
      const program = makeProgram();
      registerContribution(program, makeContribution(interactiveHandler), fakeBus);

      await program.parseAsync(['test-cmd'], { from: 'user' });

      expect(interactiveHandler).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });

    it('guards when stdin is not a TTY even if stdout is interactive', async () => {
      ttyFixture.set({ stdoutIsTTY: true, stdinIsTTY: false });
      const interactiveHandler = vi.fn(() => Promise.resolve());
      const program = makeProgram();
      registerContribution(program, makeContribution(interactiveHandler), fakeBus);

      await program.parseAsync(['test-cmd'], { from: 'user' });

      expect(interactiveHandler).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // TTY (real interactive terminal)
  // -------------------------------------------------------------------------

  describe('when stdout IS a TTY', () => {
    beforeEach(() => {
      ttyFixture.set({ stdoutIsTTY: true, stdinIsTTY: true });
    });

    it('invokes the interactive handler', async () => {
      const interactiveHandler = vi.fn(() => Promise.resolve());
      const program = makeProgram();
      registerContribution(program, makeContribution(interactiveHandler), fakeBus);

      await program.parseAsync(['test-cmd'], { from: 'user' });

      expect(interactiveHandler).toHaveBeenCalledOnce();
    });

    it('passes the bus to the interactive handler', async () => {
      const interactiveHandler = vi.fn(() => Promise.resolve());
      const program = makeProgram();
      registerContribution(program, makeContribution(interactiveHandler), fakeBus);

      await program.parseAsync(['test-cmd'], { from: 'user' });

      expect(interactiveHandler).toHaveBeenCalledWith(
        expect.objectContaining({ bus: fakeBus, signal: expect.any(AbortSignal) }),
      );
    });

    it('does NOT set process.exitCode to 1', async () => {
      const program = makeProgram();
      registerContribution(
        program,
        makeContribution(() => Promise.resolve()),
        fakeBus,
      );
      process.exitCode = 0;

      await program.parseAsync(['test-cmd'], { from: 'user' });

      expect(process.exitCode).toBe(0);
    });

    it('coerces number options before schema validation', async () => {
      const handler = vi.fn(() => Promise.resolve());
      const program = makeProgram();
      registerContribution(
        program,
        {
          name: 'stats',
          description: 'Stats command',
          subcommands: [
            {
              name: 'top',
              description: 'Show top items',
              schema: z.object({ limit: z.number() }),
              handler,
            },
          ],
        },
        fakeBus,
      );

      await program.parseAsync(['stats', 'top', '--limit', '5'], { from: 'user' });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ args: expect.objectContaining({ limit: 5 }) }));
    });

    it('coerces number positional args before schema validation', async () => {
      const handler = vi.fn(() => Promise.resolve());
      const program = makeProgram();
      registerContribution(
        program,
        {
          name: 'retry',
          description: 'Retry command',
          subcommands: [
            {
              name: 'run',
              description: 'Run retry',
              schema: z.object({
                attempts: z.number().meta({ positional: true }),
              }),
              handler,
            },
          ],
        },
        fakeBus,
      );

      await program.parseAsync(['retry', 'run', '3'], { from: 'user' });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ args: expect.objectContaining({ attempts: 3 }) }));
    });

    it('rejects blank number options before schema validation', async () => {
      const handler = vi.fn(() => Promise.resolve());
      const program = makeProgram();
      registerContribution(
        program,
        {
          name: 'stats',
          description: 'Stats command',
          subcommands: [
            {
              name: 'top',
              description: 'Show top items',
              schema: z.object({ limit: z.number() }),
              handler,
            },
          ],
        },
        fakeBus,
      );

      await expect(program.parseAsync(['stats', 'top', '--limit', '   '], { from: 'user' })).rejects.toThrow();
      expect(handler).not.toHaveBeenCalled();
    });
  });
});

describe('registerContribution — connection handling', () => {
  const ttyFixture = createTestTTYFixture();

  beforeEach(() => {
    ttyFixture.snapshot();
    process.exitCode = undefined;
  });

  afterEach(() => {
    ttyFixture.restore();
    process.exitCode = undefined;
  });

  it('sets exitCode=1 when bus is null for a subcommand', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const program = makeProgram();

    registerContribution(
      program,
      {
        name: 'test-cmd',
        description: 'A test command',
        subcommands: [
          {
            name: 'list',
            description: 'List items',
            schema: z.object({}),
            handler: vi.fn(() => Promise.resolve()),
          },
        ],
      },
      null,
    );

    try {
      await program.parseAsync(['test-cmd', 'list'], { from: 'user' });
      expect(process.exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Is it running?'));
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('sets exitCode=1 when bus is null for interactive execution', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ttyFixture.set({ stdoutIsTTY: true, stdinIsTTY: true });

    const program = makeProgram();
    registerContribution(
      program,
      makeContribution(() => Promise.resolve()),
      null,
    );

    try {
      await program.parseAsync(['test-cmd'], { from: 'user' });
      expect(process.exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Is it running?'));
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('runs handler with null bus when beforeRun returns proceed: true and bus is null', async () => {
    const handler = vi.fn(() => Promise.resolve());
    const program = makeProgram();

    registerContribution(
      program,
      {
        name: 'test-cmd',
        description: 'A test command',
        subcommands: [
          {
            name: 'list',
            description: 'List items',
            schema: z.object({}),
            handler,
          },
        ],
        async beforeRun() {
          return { proceed: true };
        },
      },
      null,
    );

    await program.parseAsync(['test-cmd', 'list'], { from: 'user' });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ bus: null }));
  });

  it('blocks execution when beforeRun returns proceed: false', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = vi.fn(() => Promise.resolve());
    const program = makeProgram();

    registerContribution(
      program,
      {
        name: 'test-cmd',
        description: 'A test command',
        subcommands: [
          {
            name: 'list',
            description: 'List items',
            schema: z.object({}),
            handler,
          },
        ],
        async beforeRun() {
          return { proceed: false, message: 'License required' };
        },
      },
      fakeBus,
    );

    try {
      await program.parseAsync(['test-cmd', 'list'], { from: 'user' });
      expect(handler).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith('License required');
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('runs interactive handler with null bus when beforeRun returns proceed: true', async () => {
    ttyFixture.set({ stdoutIsTTY: true, stdinIsTTY: true });
    const interactiveHandler = vi.fn(() => Promise.resolve());
    const program = makeProgram();

    registerContribution(
      program,
      {
        name: 'test-cmd',
        description: 'A test command',
        interactive: interactiveHandler,
        subcommands: [],
        async beforeRun() {
          return { proceed: true };
        },
      },
      null,
    );

    await program.parseAsync(['test-cmd'], { from: 'user' });
    expect(interactiveHandler).toHaveBeenCalledOnce();
    expect(interactiveHandler).toHaveBeenCalledWith(
      expect.objectContaining({ bus: null, signal: expect.any(AbortSignal) }),
    );
  });

  it('passes subcommand name and parsed args to beforeRun', async () => {
    const beforeRun = vi.fn(async () => ({ proceed: true as const }));
    const program = makeProgram();

    registerContribution(
      program,
      {
        name: 'test-cmd',
        description: 'A test command',
        subcommands: [
          {
            name: 'greet',
            description: 'Say hello',
            schema: z.object({ name: z.string().meta({ positional: true, placeholder: '<name>' }) }),
            handler: vi.fn(() => Promise.resolve()),
          },
        ],
        beforeRun,
      },
      fakeBus,
    );

    await program.parseAsync(['test-cmd', 'greet', 'Alice'], { from: 'user' });
    expect(beforeRun).toHaveBeenCalledWith(
      expect.objectContaining({ subcommandName: 'greet', args: { name: 'Alice' }, bus: fakeBus }),
    );
  });

  it('skips top-level registration when the contribution name already exists', () => {
    const program = makeProgram();
    registerContribution(
      program,
      makeContribution(() => Promise.resolve()),
      fakeBus,
    );

    expect(() => {
      registerContribution(
        program,
        makeContribution(() => Promise.resolve()),
        fakeBus,
      );
    }).not.toThrow();
    expect(program.commands.filter((command) => command.name() === 'test-cmd')).toHaveLength(1);
  });

  it('skips top-level registration when the contribution collides with an existing builtin name', () => {
    const program = makeProgram();
    program.command('serve').description('builtin');

    expect(() => {
      registerContribution(
        program,
        {
          name: 'serve',
          description: 'Should be skipped',
          subcommands: [],
        },
        fakeBus,
      );
    }).not.toThrow();
    expect(program.commands.find((command) => command.name() === 'serve')?.description()).toBe('builtin');
    expect(program.commands.filter((command) => command.name() === 'serve')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Embedded bus (provideBus) integration
// ---------------------------------------------------------------------------

describe('registerContribution — embedded bus (provideBus)', () => {
  const ttyFixture = createTestTTYFixture();

  beforeEach(() => {
    ttyFixture.snapshot();
    process.exitCode = undefined;
  });

  afterEach(() => {
    ttyFixture.restore();
    process.exitCode = undefined;
  });

  it('uses embedded bus when no external bus and calls dispose after handler', async () => {
    const { bus: embeddedBus } = createMockBus();
    const dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const handle: EmbeddedBusHandle = { bus: embeddedBus, dispose };
    const handler = vi.fn(() => Promise.resolve());
    const program = makeProgram();

    registerContribution(
      program,
      {
        name: 'workflow',
        description: 'Workflow commands',
        canProvideBus: true,
        subcommands: [{ name: 'run', description: 'Run workflow', schema: z.object({}), handler }],
        async provideBus() {
          return handle;
        },
        async beforeRun() {
          return { proceed: true };
        },
      },
      null,
    );

    await program.parseAsync(['workflow', 'run'], { from: 'user' });

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ bus: embeddedBus }));
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('does NOT call provideBus when an external bus is already connected', async () => {
    const provideBus = vi.fn<NonNullable<CliContribution['provideBus']>>().mockResolvedValue(null);
    const handler = vi.fn(() => Promise.resolve());
    const program = makeProgram();

    registerContribution(
      program,
      {
        name: 'workflow',
        description: 'Workflow commands',
        canProvideBus: true,
        subcommands: [{ name: 'run', description: 'Run workflow', schema: z.object({}), handler }],
        provideBus,
        async beforeRun() {
          return { proceed: true };
        },
      },
      fakeBus,
    );

    await program.parseAsync(['workflow', 'run'], { from: 'user' });

    expect(provideBus).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ bus: fakeBus }));
  });

  it('disposes embedded bus even when the handler throws', async () => {
    const { bus: embeddedBus } = createMockBus();
    const dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const handle: EmbeddedBusHandle = { bus: embeddedBus, dispose };
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const program = makeProgram();

    registerContribution(
      program,
      {
        name: 'workflow',
        description: 'Workflow commands',
        canProvideBus: true,
        subcommands: [
          {
            name: 'run',
            description: 'Run workflow',
            schema: z.object({}),
            handler: vi.fn().mockRejectedValue(new Error('handler boom')),
          },
        ],
        async provideBus() {
          return handle;
        },
        async beforeRun() {
          return { proceed: true };
        },
      },
      null,
    );

    try {
      await program.parseAsync(['workflow', 'run'], { from: 'user' });

      expect(dispose).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(1);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('reports provideBus failures through the command failure path', async () => {
    const handler = vi.fn(() => Promise.resolve());
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const program = makeProgram();

    registerContribution(
      program,
      {
        name: 'workflow',
        description: 'Workflow commands',
        canProvideBus: true,
        subcommands: [{ name: 'run', description: 'Run workflow', schema: z.object({}), handler }],
        async provideBus() {
          throw new Error('runtime boot failed');
        },
      },
      null,
    );

    try {
      await program.parseAsync(['workflow', 'run'], { from: 'user' });

      expect(handler).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Command failed'), 'runtime boot failed');
      expect(process.exitCode).toBe(1);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('disposes embedded bus when beforeRun throws', async () => {
    const { bus: embeddedBus } = createMockBus();
    const dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const handle: EmbeddedBusHandle = { bus: embeddedBus, dispose };
    const handler = vi.fn(() => Promise.resolve());
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const program = makeProgram();

    registerContribution(
      program,
      {
        name: 'workflow',
        description: 'Workflow commands',
        canProvideBus: true,
        subcommands: [{ name: 'run', description: 'Run workflow', schema: z.object({}), handler }],
        async provideBus() {
          return handle;
        },
        async beforeRun() {
          throw new Error('gate crashed');
        },
      },
      null,
    );

    try {
      await program.parseAsync(['workflow', 'run'], { from: 'user' });

      expect(handler).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(1);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('beforeRun receives the embedded bus', async () => {
    const { bus: embeddedBus } = createMockBus();
    const dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const handle: EmbeddedBusHandle = { bus: embeddedBus, dispose };
    const beforeRun = vi.fn(async () => ({ proceed: true as const }));
    const program = makeProgram();

    registerContribution(
      program,
      {
        name: 'workflow',
        description: 'Workflow commands',
        canProvideBus: true,
        subcommands: [
          { name: 'run', description: 'Run workflow', schema: z.object({}), handler: vi.fn(() => Promise.resolve()) },
        ],
        async provideBus() {
          return handle;
        },
        beforeRun,
      },
      null,
    );

    await program.parseAsync(['workflow', 'run'], { from: 'user' });

    expect(beforeRun).toHaveBeenCalledWith(expect.objectContaining({ bus: embeddedBus, subcommandName: 'run' }));
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('disposes embedded bus when beforeRun blocks execution', async () => {
    const { bus: embeddedBus } = createMockBus();
    const dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const handle: EmbeddedBusHandle = { bus: embeddedBus, dispose };
    const handler = vi.fn(() => Promise.resolve());
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const program = makeProgram();

    registerContribution(
      program,
      {
        name: 'workflow',
        description: 'Workflow commands',
        canProvideBus: true,
        subcommands: [{ name: 'run', description: 'Run workflow', schema: z.object({}), handler }],
        async provideBus() {
          return handle;
        },
        async beforeRun() {
          return { proceed: false, message: 'blocked by policy' };
        },
      },
      null,
    );

    try {
      await program.parseAsync(['workflow', 'run'], { from: 'user' });

      expect(handler).not.toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
      expect(process.exitCode).toBe(1);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it.each([
    'SIGINT',
    'SIGTERM',
    'SIGHUP',
  ] as const)('aborts the handler signal when %s arrives during provideBus', async (signal) => {
    const { bus: embeddedBus } = createMockBus();
    const dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const handle: EmbeddedBusHandle = { bus: embeddedBus, dispose };
    const handler = vi.fn(() => Promise.resolve());
    const program = makeProgram();

    registerContribution(
      program,
      {
        name: 'workflow',
        description: 'Workflow commands',
        canProvideBus: true,
        subcommands: [{ name: 'run', description: 'Run workflow', schema: z.object({}), handler }],
        async provideBus() {
          process.emit(signal);
          return handle;
        },
        async beforeRun() {
          return { proceed: true };
        },
      },
      null,
    );

    await program.parseAsync(['workflow', 'run'], { from: 'user' });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ signal: expect.objectContaining({ aborted: true }) }),
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('does not call provideBus when canProvideBus is omitted', async () => {
    const provideBus = vi.fn<NonNullable<CliContribution['provideBus']>>();
    const handler = vi.fn(() => Promise.resolve());
    const program = makeProgram();

    registerContribution(
      program,
      {
        name: 'workflow',
        description: 'Workflow commands',
        subcommands: [{ name: 'run', description: 'Run workflow', schema: z.object({}), handler }],
        provideBus,
        async beforeRun() {
          return { proceed: true };
        },
      },
      null,
    );

    await program.parseAsync(['workflow', 'run'], { from: 'user' });

    expect(provideBus).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ bus: null }));
  });

  it('does not call provideBus when schema validation fails', async () => {
    const provideBus = vi.fn<NonNullable<CliContribution['provideBus']>>();
    const handler = vi.fn(() => Promise.resolve());
    const program = makeProgram();

    registerContribution(
      program,
      {
        name: 'workflow',
        description: 'Workflow commands',
        canProvideBus: true,
        subcommands: [
          {
            name: 'run',
            description: 'Run workflow',
            schema: z.object({ file: z.string().min(5).meta({ positional: true }) }),
            handler,
          },
        ],
        provideBus,
      },
      null,
    );

    await expect(program.parseAsync(['workflow', 'run', 'x'], { from: 'user' })).rejects.toThrow();

    expect(provideBus).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('interactive handler receives embedded bus and dispose is called', async () => {
    ttyFixture.set({ stdoutIsTTY: true, stdinIsTTY: true });
    const { bus: embeddedBus } = createMockBus();
    const dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const handle: EmbeddedBusHandle = { bus: embeddedBus, dispose };
    const interactiveHandler = vi.fn(() => Promise.resolve());
    const program = makeProgram();

    registerContribution(
      program,
      {
        name: 'workflow',
        description: 'Workflow commands',
        canProvideBus: true,
        interactive: interactiveHandler,
        subcommands: [],
        async provideBus() {
          return handle;
        },
        async beforeRun() {
          return { proceed: true };
        },
      },
      null,
    );

    await program.parseAsync(['workflow'], { from: 'user' });

    expect(interactiveHandler).toHaveBeenCalledWith(
      expect.objectContaining({ bus: embeddedBus, signal: expect.any(AbortSignal) }),
    );
    expect(dispose).toHaveBeenCalledOnce();
  });
});
