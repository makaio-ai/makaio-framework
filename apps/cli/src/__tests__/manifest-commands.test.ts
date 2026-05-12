/**
 * Unit tests for {@link registerManifestCommand}.
 *
 * Tests use real Commander instances with `parseAsync()` to verify that
 * manifest metadata is correctly translated into Commander commands, arguments,
 * and options. Bus interaction is provided via a test-double factory so that no
 * real bus connection is established.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { z } from 'zod';
import type { CliManifest } from '@makaio/contracts';
import type { CliContribution } from '@makaio/kernel/cli';
import { createMockBus } from '@makaio/test-utils';
import { registerManifestCommand } from '../manifest-commands.js';
import type { ManifestCommandContext } from '../manifest-commands.js';
import { createTestTTYFixture } from '../test-tty-fixture.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shared fake bus for tests that only need command execution context. */
const fakeBus = createMockBus().bus;

/**
 * Create a fresh Commander program with `.exitOverride()` so Commander errors
 * throw instead of calling `process.exit`.
 */
function makeProgram(): InstanceType<typeof Command> {
  return new Command().exitOverride();
}

/**
 * Build a {@link ManifestCommandContext} using the supplied import factory and
 * a resolved fake bus.
 * @param importModule - Optional override for the contribution import function.
 * @param hasInteractive - Whether the contribution has an interactive handler.
 */
function makeCtx(
  importModule: ManifestCommandContext['importModule'] = vi.fn(),
  hasInteractive = false,
): ManifestCommandContext {
  return {
    cliEntryPath: '/fake/entry.js',
    bus: fakeBus,
    hasInteractive,
    importModule,
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const simpleManifest: CliManifest = {
  name: 'test-cmd',
  description: 'A test command',
  subcommands: [
    {
      name: 'list',
      description: 'List items',
      args: [
        { name: 'profile', description: 'Profile name', short: '-p' },
        { name: 'format', description: 'Output format' },
      ],
    },
  ],
};

const positionalManifest: CliManifest = {
  name: 'deploy',
  description: 'Deploy command',
  subcommands: [
    {
      name: 'run',
      description: 'Run deployment',
      args: [{ name: 'env', description: 'Target environment', positional: true }],
    },
  ],
};

const booleanOptionManifest: CliManifest = {
  name: 'auth',
  description: 'Auth command',
  subcommands: [
    {
      name: 'login',
      description: 'Log in',
      args: [{ name: 'verbose', description: 'Enable verbose', type: 'boolean' }],
    },
  ],
};

const numberOptionManifest: CliManifest = {
  name: 'stats',
  description: 'Stats command',
  subcommands: [
    {
      name: 'top',
      description: 'Show top items',
      args: [{ name: 'limit', description: 'Maximum items', type: 'number' }],
    },
  ],
};

const numberPositionalManifest: CliManifest = {
  name: 'retry',
  description: 'Retry command',
  subcommands: [
    {
      name: 'run',
      description: 'Run retry',
      args: [{ name: 'attempts', description: 'Attempt count', positional: true, required: true, type: 'number' }],
    },
  ],
};

const requiredOptionManifest: CliManifest = {
  name: 'config',
  description: 'Config command',
  subcommands: [
    {
      name: 'set',
      description: 'Set a value',
      args: [{ name: 'key', description: 'Config key', required: true }],
    },
  ],
};

const camelCaseOptionManifest: CliManifest = {
  name: 'account-manager',
  description: 'Auth command',
  subcommands: [
    {
      name: 'list',
      description: 'List accounts',
      args: [{ name: 'clientId', description: 'Filter by client' }],
    },
  ],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerManifestCommand', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Command registration
  // -------------------------------------------------------------------------

  it('creates a top-level command with correct name and description', () => {
    const program = makeProgram();
    registerManifestCommand(program, simpleManifest, makeCtx());

    const cmd = program.commands.find((c) => c.name() === 'test-cmd');
    expect(cmd).toBeDefined();
    expect(cmd?.description()).toBe('A test command');
  });

  it('registers subcommands with correct names and descriptions', () => {
    const program = makeProgram();
    registerManifestCommand(program, simpleManifest, makeCtx());

    const cmd = program.commands.find((c) => c.name() === 'test-cmd');
    const sub = cmd?.commands.find((c) => c.name() === 'list');
    expect(sub).toBeDefined();
    expect(sub?.description()).toBe('List items');
  });

  // -------------------------------------------------------------------------
  // Positional arguments
  // -------------------------------------------------------------------------

  it('registers positional args on the subcommand', () => {
    const program = makeProgram();
    registerManifestCommand(program, positionalManifest, makeCtx());

    const cmd = program.commands.find((c) => c.name() === 'deploy')?.commands.find((c) => c.name() === 'run');

    expect(cmd?.registeredArguments).toHaveLength(1);
    expect(cmd?.registeredArguments[0]?.name()).toBe('env');
  });

  // -------------------------------------------------------------------------
  // Named options
  // -------------------------------------------------------------------------

  it('registers named options with short flags', () => {
    const program = makeProgram();
    registerManifestCommand(program, simpleManifest, makeCtx());

    const sub = program.commands.find((c) => c.name() === 'test-cmd')?.commands.find((c) => c.name() === 'list');

    const optionFlags = sub?.options.map((o) => o.flags) ?? [];
    expect(optionFlags.some((f) => f.includes('--profile') && f.includes('-p'))).toBe(true);
  });

  it('registers camelCase option names as kebab-case long flags', () => {
    const program = makeProgram();
    registerManifestCommand(program, camelCaseOptionManifest, makeCtx());

    const sub = program.commands.find((c) => c.name() === 'account-manager')?.commands.find((c) => c.name() === 'list');

    const optionFlags = sub?.options.map((o) => o.flags) ?? [];
    expect(optionFlags).toContain('--client-id <clientId>');
  });

  it('registers boolean options as flags (no value placeholder)', () => {
    const program = makeProgram();
    registerManifestCommand(program, booleanOptionManifest, makeCtx());

    const sub = program.commands.find((c) => c.name() === 'auth')?.commands.find((c) => c.name() === 'login');

    const verboseOpt = sub?.options.find((o) => o.long === '--verbose');
    expect(verboseOpt).toBeDefined();
    // Boolean flags have no value placeholder — `mandatory` is false and flags don't include `<`
    expect(verboseOpt?.flags).not.toContain('<');
  });

  it('marks required options as mandatory', () => {
    const program = makeProgram();
    registerManifestCommand(program, requiredOptionManifest, makeCtx());

    const sub = program.commands.find((c) => c.name() === 'config')?.commands.find((c) => c.name() === 'set');

    const keyOpt = sub?.options.find((o) => o.long === '--key');
    expect(keyOpt?.mandatory).toBe(true);
  });

  it('coerces number options before handler schema validation', async () => {
    const subcommandHandler = vi.fn(() => Promise.resolve());
    const contribution: CliContribution = {
      name: 'stats',
      description: 'Stats command',
      subcommands: [
        {
          name: 'top',
          description: 'Show top items',
          schema: z.object({ limit: z.number() }),
          handler: subcommandHandler,
        },
      ],
    };
    const importModule = vi.fn(() => Promise.resolve(contribution));
    const program = makeProgram();
    registerManifestCommand(program, numberOptionManifest, makeCtx(importModule));

    await program.parseAsync(['stats', 'top', '--limit', '5'], { from: 'user' });

    expect(subcommandHandler).toHaveBeenCalledWith(
      expect.objectContaining({ args: expect.objectContaining({ limit: 5 }) }),
    );
  });

  it('coerces number positional args before handler schema validation', async () => {
    const subcommandHandler = vi.fn(() => Promise.resolve());
    const contribution: CliContribution = {
      name: 'retry',
      description: 'Retry command',
      subcommands: [
        {
          name: 'run',
          description: 'Run retry',
          schema: z.object({ attempts: z.number() }),
          handler: subcommandHandler,
        },
      ],
    };
    const importModule = vi.fn(() => Promise.resolve(contribution));
    const program = makeProgram();
    registerManifestCommand(program, numberPositionalManifest, makeCtx(importModule));

    await program.parseAsync(['retry', 'run', '3'], { from: 'user' });

    expect(subcommandHandler).toHaveBeenCalledWith(
      expect.objectContaining({ args: expect.objectContaining({ attempts: 3 }) }),
    );
  });

  // -------------------------------------------------------------------------
  // Lazy action — not called at registration time
  // -------------------------------------------------------------------------

  it('does NOT call importModule at registration time', () => {
    const importModule = vi.fn();
    const program = makeProgram();
    registerManifestCommand(program, simpleManifest, makeCtx(importModule));

    expect(importModule).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Action dispatch — called when command is parsed
  // -------------------------------------------------------------------------

  it('calls importModule and handler when subcommand is parsed', async () => {
    const subcommandHandler = vi.fn(() => Promise.resolve());
    const contribution: CliContribution = {
      name: 'test-cmd',
      description: 'A test command',
      subcommands: [
        {
          name: 'list',
          description: 'List items',
          schema: z.object({}),
          handler: subcommandHandler,
        },
      ],
    };
    const importModule = vi.fn(() => Promise.resolve(contribution));

    const program = makeProgram();
    registerManifestCommand(program, simpleManifest, makeCtx(importModule));

    await program.parseAsync(['test-cmd', 'list'], { from: 'user' });

    expect(importModule).toHaveBeenCalledWith('/fake/entry.js');
    expect(subcommandHandler).toHaveBeenCalledOnce();
  });

  it('passes bus to handler', async () => {
    const subcommandHandler = vi.fn(() => Promise.resolve());
    const contribution: CliContribution = {
      name: 'test-cmd',
      description: 'A test command',
      subcommands: [
        {
          name: 'list',
          description: 'List items',
          schema: z.object({}),
          handler: subcommandHandler,
        },
      ],
    };
    const importModule = vi.fn(() => Promise.resolve(contribution));

    const program = makeProgram();
    registerManifestCommand(program, simpleManifest, makeCtx(importModule));

    await program.parseAsync(['test-cmd', 'list'], { from: 'user' });

    expect(subcommandHandler).toHaveBeenCalledWith(expect.objectContaining({ bus: fakeBus }));
  });
});

// ---------------------------------------------------------------------------
// Error handling — resolveAndExecute
// ---------------------------------------------------------------------------

describe('registerManifestCommand — error handling', () => {
  let originalExitCode: number | undefined;

  beforeEach(() => {
    originalExitCode = process.exitCode as number | undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('throws a CommanderError when Zod schema rejects valid-looking arg', async () => {
    const zodValidationManifest: CliManifest = {
      name: 'greet',
      description: 'Greet command',
      subcommands: [
        {
          name: 'say',
          description: 'Say hello',
          args: [{ name: 'name', description: 'Name to greet', positional: true, required: true }],
        },
      ],
    };
    const contribution: CliContribution = {
      name: 'greet',
      description: 'Greet command',
      subcommands: [
        {
          name: 'say',
          description: 'Say hello',
          schema: z.object({ name: z.string().min(5) }),
          handler: vi.fn(() => Promise.resolve()),
        },
      ],
    };
    const importModule = vi.fn(() => Promise.resolve(contribution));

    const program = makeProgram();
    registerManifestCommand(program, zodValidationManifest, makeCtx(importModule));

    // Commander accepts "hi" as a positional arg, but the Zod schema (min(5))
    // rejects it. resolveAndExecute calls cmd.error() which throws a
    // CommanderError because exitOverride is active on the root program.
    await expect(program.parseAsync(['greet', 'say', 'hi'], { from: 'user' })).rejects.toThrow();
  });

  it('sets exit code 1 and logs an error when importModule throws', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const importModule = vi.fn().mockRejectedValue(new Error('Module not found'));
    const program = makeProgram();
    registerManifestCommand(program, simpleManifest, makeCtx(importModule));

    await program.parseAsync(['test-cmd', 'list'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('/fake/entry.js'), 'Module not found');
  });

  it('sets exit code 1 and logs the connection error when bus is null', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const contribution: CliContribution = {
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
    };
    const importModule = vi.fn(() => Promise.resolve(contribution));
    const ctx: ManifestCommandContext = {
      cliEntryPath: '/fake/entry.js',
      bus: null,
      connectionError: 'Bus unavailable',
      hasInteractive: false,
      importModule,
    };
    const program = makeProgram();
    registerManifestCommand(program, simpleManifest, ctx);

    await program.parseAsync(['test-cmd', 'list'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith('Bus unavailable');
  });

  it('surfaces module import failures before the connection error when bus is null', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const importModule = vi.fn().mockRejectedValue(new Error('Module not found'));
    const ctx: ManifestCommandContext = {
      cliEntryPath: '/fake/entry.js',
      bus: null,
      connectionError: 'Bus unavailable',
      hasInteractive: false,
      importModule,
    };
    const program = makeProgram();
    registerManifestCommand(program, simpleManifest, ctx);

    await program.parseAsync(['test-cmd', 'list'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('/fake/entry.js'), 'Module not found');
    expect(consoleErrorSpy).not.toHaveBeenCalledWith('Bus unavailable');
  });

  it('runs handler with null bus when beforeRun returns proceed: true', async () => {
    const handler = vi.fn(() => Promise.resolve());
    const contribution: CliContribution = {
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
    };
    const importModule = vi.fn(() => Promise.resolve(contribution));
    const ctx: ManifestCommandContext = {
      cliEntryPath: '/fake/entry.js',
      bus: null,
      connectionError: 'Bus unavailable',
      hasInteractive: false,
      importModule,
    };
    const program = makeProgram();
    registerManifestCommand(program, simpleManifest, ctx);

    await program.parseAsync(['test-cmd', 'list'], { from: 'user' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ bus: null }));
    expect(process.exitCode).toBe(originalExitCode);
  });

  it('blocks execution when beforeRun returns proceed: false', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handler = vi.fn(() => Promise.resolve());
    const contribution: CliContribution = {
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
        return { proceed: false, message: 'Upgrade to Pro' };
      },
    };
    const importModule = vi.fn(() => Promise.resolve(contribution));
    const ctx = makeCtx(importModule);
    const program = makeProgram();
    registerManifestCommand(program, simpleManifest, ctx);

    await program.parseAsync(['test-cmd', 'list'], { from: 'user' });

    expect(handler).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith('Upgrade to Pro');
  });

  it('sets exit code 1 and logs error when handler throws', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const contribution: CliContribution = {
      name: 'test-cmd',
      description: 'A test command',
      subcommands: [
        {
          name: 'list',
          description: 'List items',
          schema: z.object({}),
          handler: vi.fn().mockRejectedValue(new Error('Handler exploded')),
        },
      ],
    };
    const importModule = vi.fn(() => Promise.resolve(contribution));
    const ctx = makeCtx(importModule);
    const program = makeProgram();
    registerManifestCommand(program, simpleManifest, ctx);

    await program.parseAsync(['test-cmd', 'list'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Command failed'), 'Handler exploded');
  });

  it('throws a Commander error when a manifest number option is not numeric', async () => {
    const contribution: CliContribution = {
      name: 'stats',
      description: 'Stats command',
      subcommands: [
        {
          name: 'top',
          description: 'Show top items',
          schema: z.object({ limit: z.number() }),
          handler: vi.fn(() => Promise.resolve()),
        },
      ],
    };
    const importModule = vi.fn(() => Promise.resolve(contribution));
    const program = makeProgram();
    registerManifestCommand(program, numberOptionManifest, makeCtx(importModule));

    await expect(program.parseAsync(['stats', 'top', '--limit', 'many'], { from: 'user' })).rejects.toThrow();
  });

  it('throws a Commander error when a manifest number option is blank', async () => {
    const contribution: CliContribution = {
      name: 'stats',
      description: 'Stats command',
      subcommands: [
        {
          name: 'top',
          description: 'Show top items',
          schema: z.object({ limit: z.number() }),
          handler: vi.fn(() => Promise.resolve()),
        },
      ],
    };
    const importModule = vi.fn(() => Promise.resolve(contribution));
    const program = makeProgram();
    registerManifestCommand(program, numberOptionManifest, makeCtx(importModule));

    await expect(program.parseAsync(['stats', 'top', '--limit', '   '], { from: 'user' })).rejects.toThrow();
  });

  it('surfaces schema validation failures before the connection error when bus is null', async () => {
    const contribution: CliContribution = {
      name: 'greet',
      description: 'Greet command',
      subcommands: [
        {
          name: 'say',
          description: 'Say hello',
          schema: z.object({ name: z.string().min(5) }),
          handler: vi.fn(() => Promise.resolve()),
        },
      ],
    };
    const importModule = vi.fn(() => Promise.resolve(contribution));
    const ctx: ManifestCommandContext = {
      cliEntryPath: '/fake/entry.js',
      bus: null,
      connectionError: 'Bus unavailable',
      hasInteractive: false,
      importModule,
    };
    const program = makeProgram();
    registerManifestCommand(
      program,
      {
        name: 'greet',
        description: 'Greet command',
        subcommands: [
          {
            name: 'say',
            description: 'Say hello',
            args: [{ name: 'name', description: 'Name to greet', positional: true, required: true }],
          },
        ],
      },
      ctx,
    );

    await expect(program.parseAsync(['greet', 'say', 'hi'], { from: 'user' })).rejects.toThrow();
    expect(process.exitCode).toBe(originalExitCode);
  });

  it('logs a user-friendly error when contribution has no interactive handler (resolveAndExecuteInteractive)', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const ttyFixture = createTestTTYFixture();
    ttyFixture.snapshot();
    ttyFixture.set({ stdoutIsTTY: true, stdinIsTTY: true });

    const contribution: CliContribution = {
      name: 'tui-cmd',
      description: 'Interactive command',
      // no interactive property
      subcommands: [],
    };
    const importModule = vi.fn(() => Promise.resolve(contribution));
    const interactiveManifest: CliManifest = {
      name: 'tui-cmd',
      description: 'Interactive command',
      subcommands: [],
    };
    const ctx = makeCtx(importModule, true);
    const program = makeProgram();
    registerManifestCommand(program, interactiveManifest, ctx);

    try {
      await program.parseAsync(['tui-cmd'], { from: 'user' });

      expect(process.exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining("'tui-cmd'"));
    } finally {
      consoleErrorSpy.mockRestore();
      ttyFixture.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// TTY guard for interactive
// ---------------------------------------------------------------------------

describe('registerManifestCommand — interactive TTY guard', () => {
  let originalExitCode: number | undefined;
  const ttyFixture = createTestTTYFixture();

  beforeEach(() => {
    ttyFixture.snapshot();
    originalExitCode = process.exitCode as number | undefined;
  });

  afterEach(() => {
    ttyFixture.restore();
    process.exitCode = originalExitCode;
    vi.clearAllMocks();
  });

  const interactiveManifest: CliManifest = {
    name: 'tui-cmd',
    description: 'Interactive command',
    subcommands: [],
  };

  it('does NOT invoke interactive handler when stdout is not a TTY', async () => {
    ttyFixture.set({ stdoutIsTTY: false, stdinIsTTY: true });

    const interactiveHandler = vi.fn(() => Promise.resolve());
    const contribution: CliContribution = {
      name: 'tui-cmd',
      description: 'Interactive command',
      interactive: interactiveHandler,
      subcommands: [],
    };
    const importModule = vi.fn(() => Promise.resolve(contribution));
    const ctx = makeCtx(importModule, true);

    const program = makeProgram();
    registerManifestCommand(program, interactiveManifest, ctx);

    await program.parseAsync(['tui-cmd'], { from: 'user' });

    expect(interactiveHandler).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('does NOT invoke interactive handler when stdin is not a TTY', async () => {
    ttyFixture.set({ stdoutIsTTY: true, stdinIsTTY: false });

    const interactiveHandler = vi.fn(() => Promise.resolve());
    const contribution: CliContribution = {
      name: 'tui-cmd',
      description: 'Interactive command',
      interactive: interactiveHandler,
      subcommands: [],
    };
    const importModule = vi.fn(() => Promise.resolve(contribution));
    const ctx = makeCtx(importModule, true);

    const program = makeProgram();
    registerManifestCommand(program, interactiveManifest, ctx);

    await program.parseAsync(['tui-cmd'], { from: 'user' });

    expect(interactiveHandler).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it('invokes interactive handler when stdin and stdout are TTYs', async () => {
    ttyFixture.set({ stdoutIsTTY: true, stdinIsTTY: true });

    const interactiveHandler = vi.fn(() => Promise.resolve());
    const contribution: CliContribution = {
      name: 'tui-cmd',
      description: 'Interactive command',
      interactive: interactiveHandler,
      subcommands: [],
    };
    const importModule = vi.fn(() => Promise.resolve(contribution));
    const ctx = makeCtx(importModule, true);

    const program = makeProgram();
    registerManifestCommand(program, interactiveManifest, ctx);

    await program.parseAsync(['tui-cmd'], { from: 'user' });

    expect(interactiveHandler).toHaveBeenCalledOnce();
    expect(interactiveHandler).toHaveBeenCalledWith({ bus: fakeBus });
  });
});

// ---------------------------------------------------------------------------
// Command-tree merge scenarios
// ---------------------------------------------------------------------------

describe('registerManifestCommand — command-tree merge', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('merges subcommands into an existing parent command', () => {
    const program = makeProgram();
    // Pre-register a 'client' command with a 'status' subcommand.
    const preexistingClient = program.command('client').description('Pre-existing client');
    preexistingClient.command('status').description('Pre-existing status');

    const clientMergeManifest: CliManifest = {
      name: 'client',
      description: 'Client command',
      subcommands: [{ name: 'wire', description: 'Wire a connection' }],
    };
    registerManifestCommand(program, clientMergeManifest, makeCtx());

    // Only one 'client' command should exist on the program.
    const clientCommands = program.commands.filter((c) => c.name() === 'client');
    expect(clientCommands).toHaveLength(1);

    // Both 'status' and 'wire' must be present as subcommands.
    const clientCmd = clientCommands[0]!;
    const subNames = clientCmd.commands.map((c) => c.name());
    expect(subNames).toContain('status');
    expect(subNames).toContain('wire');
  });

  it('skips duplicate subcommands with a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const program = makeProgram();
    // Pre-register a 'client' command with a 'status' subcommand.
    const preexistingClient = program.command('client').description('Pre-existing client');
    preexistingClient.command('status').description('Pre-existing status');

    const duplicateManifest: CliManifest = {
      name: 'client',
      description: 'Client command',
      subcommands: [{ name: 'status', description: 'Duplicate status' }],
    };
    registerManifestCommand(program, duplicateManifest, makeCtx());

    // console.warn must have been called for the collision.
    expect(warnSpy).toHaveBeenCalled();

    // Only one 'status' subcommand must exist on the merged parent.
    const clientCmd = program.commands.find((c) => c.name() === 'client')!;
    const statusCommands = clientCmd.commands.filter((c) => c.name() === 'status');
    expect(statusCommands).toHaveLength(1);
  });

  it('does not attach an interactive action when the parent command already existed', async () => {
    const program = makeProgram();
    // Pre-register 'client' — the command existed before registerManifestCommand runs.
    const preexistingClient = program.command('client').description('Pre-existing client');

    const interactiveManifest: CliManifest = {
      name: 'client',
      description: 'Client command',
      subcommands: [],
    };
    // hasInteractive: true would normally attach an action, but only when the
    // command is newly created (created === true). Since it already existed,
    // no action should be attached.
    const importModule = vi.fn(() => Promise.resolve({ name: 'client', description: 'Client', subcommands: [] }));
    registerManifestCommand(program, interactiveManifest, makeCtx(importModule, true));

    // If an action had been attached it would call importModule when parsed.
    await program.parseAsync(['client'], { from: 'user' });

    expect(importModule).not.toHaveBeenCalled();
    // The pre-existing command reference is unchanged.
    expect(program.commands.find((c) => c.name() === 'client')).toBe(preexistingClient);
  });
});

// ---------------------------------------------------------------------------
// Interactive error paths
// ---------------------------------------------------------------------------

describe('registerManifestCommand — interactive error paths', () => {
  let originalExitCode: number | undefined;
  const ttyFixture = createTestTTYFixture();

  const interactiveManifest: CliManifest = {
    name: 'tui-cmd',
    description: 'Interactive command',
    subcommands: [],
  };

  beforeEach(() => {
    originalExitCode = process.exitCode as number | undefined;
    ttyFixture.snapshot();
    ttyFixture.set({ stdoutIsTTY: true, stdinIsTTY: true });
  });

  afterEach(() => {
    ttyFixture.restore();
    process.exitCode = originalExitCode;
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('sets exit code 1 and logs the connection error when bus is null during interactive', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const contribution: CliContribution = {
      name: 'tui-cmd',
      description: 'Interactive command',
      interactive: vi.fn(() => Promise.resolve()),
      subcommands: [],
    };
    const importModule = vi.fn(() => Promise.resolve(contribution));
    const ctx: ManifestCommandContext = {
      cliEntryPath: '/fake/entry.js',
      bus: null,
      connectionError: 'Bus unavailable',
      hasInteractive: true,
      importModule,
    };
    const program = makeProgram();
    registerManifestCommand(program, interactiveManifest, ctx);

    await program.parseAsync(['tui-cmd'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith('Bus unavailable');
    expect(contribution.interactive).not.toHaveBeenCalled();
  });

  it('sets exit code 1 and logs error when interactive handler throws', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const contribution: CliContribution = {
      name: 'tui-cmd',
      description: 'Interactive command',
      interactive: vi.fn().mockRejectedValue(new Error('TUI crashed')),
      subcommands: [],
    };
    const importModule = vi.fn(() => Promise.resolve(contribution));
    const ctx = makeCtx(importModule, true);
    const program = makeProgram();
    registerManifestCommand(program, interactiveManifest, ctx);

    await program.parseAsync(['tui-cmd'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Command failed'), 'TUI crashed');
  });

  it('surfaces import failures before the connection error during interactive execution', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const importModule = vi.fn().mockRejectedValue(new Error('Module not found'));
    const ctx: ManifestCommandContext = {
      cliEntryPath: '/fake/entry.js',
      bus: null,
      connectionError: 'Bus unavailable',
      hasInteractive: true,
      importModule,
    };
    const program = makeProgram();
    registerManifestCommand(program, interactiveManifest, ctx);

    await program.parseAsync(['tui-cmd'], { from: 'user' });

    expect(process.exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('/fake/entry.js'), 'Module not found');
    expect(consoleErrorSpy).not.toHaveBeenCalledWith('Bus unavailable');
  });
});
