/**
 * Unit tests for {@link registerAutoLaunchCommand}.
 *
 * Tests operate on real Commander instances to verify that the command tree
 * registered by `registerAutoLaunchCommand` exposes the expected subcommands.
 * No bus connection is established — command structure assertions are purely
 * structural and do not invoke any action handlers.
 */
import { describe, it, expect } from 'bun:test';
import { Command } from 'commander';
import { registerAutoLaunchCommand } from '../auto-launch-command.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh Commander program with `.exitOverride()` so Commander errors
 * throw instead of calling `process.exit`, keeping tests hermetic.
 */
function makeProgram(): InstanceType<typeof Command> {
  return new Command().exitOverride();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerAutoLaunchCommand', () => {
  it('registers an "auto-launch" subcommand on the program', () => {
    const program = makeProgram();
    registerAutoLaunchCommand(program);

    const cmd = program.commands.find((c) => c.name() === 'auto-launch');

    expect(cmd).toBeDefined();
  });

  it('registers enable, disable, and status subcommands under auto-launch', () => {
    const program = makeProgram();
    registerAutoLaunchCommand(program);

    const cmd = program.commands.find((c) => c.name() === 'auto-launch');

    expect(cmd!.commands.map((c) => c.name()).sort()).toEqual(['disable', 'enable', 'status']);
  });

  it('auto-launch command has a description', () => {
    const program = makeProgram();
    registerAutoLaunchCommand(program);

    const cmd = program.commands.find((c) => c.name() === 'auto-launch');

    expect(cmd!.description()).toBeTruthy();
  });

  it('each subcommand has a description', () => {
    const program = makeProgram();
    registerAutoLaunchCommand(program);

    const cmd = program.commands.find((c) => c.name() === 'auto-launch');
    const subcommandDescriptions = cmd!.commands.map((c) => c.description());

    expect(subcommandDescriptions.every((d) => d.length > 0)).toBe(true);
  });
});
