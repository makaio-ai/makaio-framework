/// <reference types="bun-types" />
/**
 * Unit tests for command-tree composition utilities.
 *
 * All tests operate on real Commander instances — no mocking of Commander
 * internals — so assertions reflect the actual runtime behaviour of
 * {@link findOrCreateCommand}, {@link hasRegisteredCommandName}, and
 * {@link claimSubcommandName}.
 */
import { describe, expect, it, mock, spyOn, afterEach } from 'bun:test';
import { Command } from 'commander';
import { claimSubcommandName, findOrCreateCommand, hasRegisteredCommandName } from '../command-tree.js';

/**
 * Create a fresh Commander program with `.exitOverride()` so Commander errors
 * throw instead of calling `process.exit`.
 */
function makeProgram(): InstanceType<typeof Command> {
  return new Command().exitOverride();
}

// ---------------------------------------------------------------------------
// findOrCreateCommand
// ---------------------------------------------------------------------------

describe('findOrCreateCommand', () => {
  it('creates a new child command when the name is absent', () => {
    const program = makeProgram();

    const { cmd, created } = findOrCreateCommand(program, 'widget', 'Widget command');

    expect(cmd.name()).toBe('widget');
    expect(created).toBe(true);
    expect(program.commands).toHaveLength(1);
  });

  it('returns the existing child command when the name is already present', () => {
    const program = makeProgram();
    const existing = program.command('widget').description('Original description');

    const { cmd, created } = findOrCreateCommand(program, 'widget', 'New description');

    expect(cmd).toBe(existing);
    expect(created).toBe(false);
    // No extra command was appended.
    expect(program.commands).toHaveLength(1);
  });

  it('does not overwrite the description of an existing command', () => {
    const program = makeProgram();
    program.command('widget').description('Description A');

    const { cmd } = findOrCreateCommand(program, 'widget', 'Description B');

    expect(cmd.description()).toBe('Description A');
  });
});

// ---------------------------------------------------------------------------
// hasRegisteredCommandName
// ---------------------------------------------------------------------------

describe('hasRegisteredCommandName', () => {
  it('returns false when the name is absent', () => {
    const program = makeProgram();

    expect(hasRegisteredCommandName(program, 'missing')).toBe(false);
  });

  it('returns true when the name is present', () => {
    const program = makeProgram();
    program.command('present');

    expect(hasRegisteredCommandName(program, 'present')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// claimSubcommandName
// ---------------------------------------------------------------------------

describe('claimSubcommandName', () => {
  afterEach(() => {
    mock.restore();
  });

  it('returns true and does not warn when the name is free', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    const program = makeProgram();

    const result = claimSubcommandName(program, 'free-cmd', 'parent free-cmd', 'test source');

    expect(result).toBe(true);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns false and warns when the name is already taken', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    const program = makeProgram();
    program.command('taken-cmd');

    const result = claimSubcommandName(program, 'taken-cmd', 'parent taken-cmd', 'test source');

    expect(result).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'parent taken-cmd'"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('test source'));
  });
});
