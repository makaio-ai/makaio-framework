import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { createBusInstance } from '@makaio/bus-core';
import { defineCliSubcommand, type CliContribution } from '../cli/index.js';
import { handleExecute, handleListContributions } from './cli-rpc-handlers.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const testSchema = z.object({
  name: z.string().meta({ description: 'Name', positional: true }),
  verbose: z.boolean().optional().meta({ description: 'Verbose output' }),
});

/**
 * Build a {@link CliContribution} for use in tests.
 * @param overrides - Optional partial overrides applied on top of defaults.
 * @returns A CliContribution with one `greet` subcommand by default.
 */
function makeContribution(overrides?: Partial<CliContribution>): CliContribution {
  return {
    name: 'test-cmd',
    description: 'Test command',
    subcommands: [
      defineCliSubcommand('greet', 'Say hello', testSchema, async (ctx) => {
        ctx.output.write(`Hello, ${ctx.args.name}!\n`);
      }),
    ],
    ...overrides,
  };
}

const bus = createBusInstance();

// ---------------------------------------------------------------------------
// handleListContributions
// ---------------------------------------------------------------------------

describe('handleListContributions', () => {
  it('returns empty array for empty contributions', () => {
    expect(handleListContributions([])).toEqual([]);
  });

  it('maps a single contribution with subcommands and arg metadata', () => {
    const contribution = makeContribution();

    expect(handleListContributions([contribution])).toEqual([
      {
        name: 'test-cmd',
        description: 'Test command',
        hasInteractive: false,
        subcommands: [
          {
            name: 'greet',
            description: 'Say hello',
            args: [
              { name: 'name', description: 'Name', required: true, positional: true },
              { name: 'verbose', description: 'Verbose output', type: 'boolean' },
            ],
          },
        ],
      },
    ]);
  });

  it('sets hasInteractive to true when interactive handler is present', () => {
    const contribution = makeContribution({
      interactive: async () => undefined,
    });

    const [manifest] = handleListContributions([contribution]);
    expect(manifest.hasInteractive).toBe(true);
  });

  it('maps multiple contributions in order', () => {
    const first = makeContribution({ name: 'cmd-a', description: 'Command A' });
    const second = makeContribution({ name: 'cmd-b', description: 'Command B' });

    const result = handleListContributions([first, second]);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('cmd-a');
    expect(result[1].name).toBe('cmd-b');
  });
});

// ---------------------------------------------------------------------------
// handleExecute
// ---------------------------------------------------------------------------

describe('handleExecute', () => {
  it('returns exitCode 1 and stderr for unknown command', async () => {
    const result = await handleExecute(
      { command: 'no-such-cmd', subcommand: 'greet', args: { name: 'Alice' } },
      [makeContribution()],
      bus,
    );

    expect(result).toEqual({
      exitCode: 1,
      stdout: [],
      stderr: ['Unknown command: no-such-cmd'],
    });
  });

  it('returns exitCode 1 and stderr for unknown subcommand', async () => {
    const result = await handleExecute(
      { command: 'test-cmd', subcommand: 'no-such-sub', args: { name: 'Alice' } },
      [makeContribution()],
      bus,
    );

    expect(result).toEqual({
      exitCode: 1,
      stdout: [],
      stderr: ['Unknown subcommand: no-such-sub'],
    });
  });

  it('returns exitCode 1 with Validation failed lines when args are invalid', async () => {
    // `name` is required (non-optional string) — omitting it triggers a validation error
    const result = await handleExecute(
      { command: 'test-cmd', subcommand: 'greet', args: {} },
      [makeContribution()],
      bus,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toEqual([]);
    expect(result.stderr[0]).toBe('Validation failed:');
    expect(result.stderr.length).toBeGreaterThan(1);
  });

  it('captures stdout and returns exitCode 0 on successful execution', async () => {
    const result = await handleExecute(
      { command: 'test-cmd', subcommand: 'greet', args: { name: 'World' } },
      [makeContribution()],
      bus,
    );

    expect(result).toEqual({
      exitCode: 0,
      stdout: ['Hello, World!\n'],
      stderr: [],
    });
  });

  it('captures stderr when handler writes to output.error()', async () => {
    const contribution = makeContribution({
      subcommands: [
        defineCliSubcommand('warn', 'Emit a warning', z.object({}), async (ctx) => {
          ctx.output.error('Something went wrong\n');
        }),
      ],
    });

    const result = await handleExecute({ command: 'test-cmd', subcommand: 'warn', args: {} }, [contribution], bus);

    expect(result).toEqual({
      exitCode: 0,
      stdout: [],
      stderr: ['Something went wrong\n'],
    });
  });

  it('returns the exit code set by setExitCode()', async () => {
    const contribution = makeContribution({
      subcommands: [
        defineCliSubcommand('exit', 'Exit with custom code', z.object({}), async (ctx) => {
          ctx.setExitCode(42);
        }),
      ],
    });

    const result = await handleExecute({ command: 'test-cmd', subcommand: 'exit', args: {} }, [contribution], bus);

    expect(result).toEqual({
      exitCode: 42,
      stdout: [],
      stderr: [],
    });
  });

  it('returns exitCode 1 and appends error message when handler throws', async () => {
    const contribution = makeContribution({
      subcommands: [
        defineCliSubcommand('boom', 'Throw an error', z.object({}), async () => {
          throw new Error('Handler exploded');
        }),
      ],
    });

    const result = await handleExecute({ command: 'test-cmd', subcommand: 'boom', args: {} }, [contribution], bus);

    expect(result).toEqual({
      exitCode: 1,
      stdout: [],
      stderr: ['Handler exploded'],
    });
  });

  it('preserves setExitCode value when handler calls setExitCode then throws', async () => {
    const contribution = makeContribution({
      subcommands: [
        defineCliSubcommand('set-then-throw', 'Set code then throw', z.object({}), async (ctx) => {
          ctx.setExitCode(3);
          throw new Error('Post-setExitCode failure');
        }),
      ],
    });

    const result = await handleExecute(
      { command: 'test-cmd', subcommand: 'set-then-throw', args: {} },
      [contribution],
      bus,
    );

    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('Post-setExitCode failure');
  });
});
