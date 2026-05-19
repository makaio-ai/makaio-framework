/**
 * Tests for {@link registerSetupCommand}.
 *
 * Uses real Commander instances with `parseAsync()` driven via argv strings so
 * that CLI parsing is exercised end-to-end.
 *
 * The setup TUI module is lazy-loaded at runtime — tests mock the dynamic import
 * with Ink's renderer replaced by a controlled boundary. Tests focus on CLI
 * wiring, error handling when the bus is absent, and executing the real TUI
 * entry path without taking over the terminal.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { createMockBus } from '@makaio/test-utils';
import { registerSetupCommand } from './setup-command.js';
import type { SetupCommandContext } from './setup-command.js';
import type { ReactNode } from 'react';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh Commander program with `.exitOverride()` so that Commander
 * errors throw instead of calling `process.exit`, keeping tests isolated.
 * @returns A fresh Commander program.
 */
function makeProgram(): InstanceType<typeof Command> {
  return new Command('makaio').exitOverride();
}

/**
 * Build a {@link SetupCommandContext} for tests.
 * @param busOrNull - Connected bus mock, or `null` to simulate offline state.
 * @param makaioHome - Absolute path to the makaio home directory.
 */
function makeCtx(
  busOrNull: ReturnType<typeof createMockBus>['bus'] | null,
  makaioHome = '/tmp/test-makaio-home',
): SetupCommandContext {
  return { bus: busOrNull, makaioHome };
}

// ---------------------------------------------------------------------------
// Command registration
// ---------------------------------------------------------------------------

describe('registerSetupCommand — registration', () => {
  it('registers "setup" as a top-level command', () => {
    const program = makeProgram();
    const { bus } = createMockBus();
    registerSetupCommand(program, makeCtx(bus));

    const names = program.commands.map((c) => c.name());
    expect(names).toContain('setup');
  });

  it('registers "setup" with the correct description', () => {
    const program = makeProgram();
    const { bus } = createMockBus();
    registerSetupCommand(program, makeCtx(bus));

    const cmd = program.commands.find((c) => c.name() === 'setup');
    expect(cmd?.description()).toBe('Run guided first-time setup');
  });
});

// ---------------------------------------------------------------------------
// Offline / connection error
// ---------------------------------------------------------------------------

describe('registerSetupCommand — connection error', () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it('sets exitCode=1 when bus is null', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = makeProgram();
    registerSetupCommand(program, makeCtx(null));

    await program.parseAsync(['node', 'makaio', 'setup']);

    expect(process.exitCode).toBe(1);
    consoleSpy.mockRestore();
  });

  it('writes a server-start hint to console.error when bus is null', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const program = makeProgram();
    registerSetupCommand(program, makeCtx(null));

    await program.parseAsync(['node', 'makaio', 'setup']);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('requires a running'));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('makaio serve'));
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// TUI invocation
// ---------------------------------------------------------------------------

describe('registerSetupCommand — TUI invocation', () => {
  const inkRenderMock = vi.fn(() => ({ waitUntilExit: async () => undefined }));
  let tempDirs: string[] = [];

  /**
   * Creates an isolated Makaio home directory for tests that exercise the real setup controller.
   * @returns Temporary Makaio home path.
   */
  async function makeMakaioHome(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'makaio-setup-command-'));
    tempDirs.push(dir);
    return dir;
  }

  beforeEach(() => {
    process.exitCode = undefined;
    inkRenderMock.mockClear();
    vi.doMock('ink', async () => {
      const React = await import('react');
      return {
        render: inkRenderMock,
        Box: ({ children }: { readonly children?: ReactNode }) => React.createElement('div', null, children),
        Text: ({ children }: { readonly children?: ReactNode }) => React.createElement('span', null, children),
        useApp: () => ({ exit: vi.fn() }),
      };
    });
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.resetModules();
    const dirs = tempDirs;
    tempDirs = [];
    return Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))).then(() => undefined);
  });

  it('executes the real TUI entry path when bus is connected', async () => {
    const { bus } = createMockBus();
    const makaioHome = await makeMakaioHome();
    const { registerSetupCommand: freshRegister } = await import('./setup-command.js');
    const program = makeProgram();
    freshRegister(program, { bus, makaioHome });

    await program.parseAsync(['node', 'makaio', 'setup']);

    expect(inkRenderMock).toHaveBeenCalledOnce();
  });

  it('does not set exitCode when runSetupTui resolves normally', async () => {
    const { bus } = createMockBus();
    const { registerSetupCommand: freshRegister } = await import('./setup-command.js');
    const program = makeProgram();
    freshRegister(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'setup']);

    expect(process.exitCode).not.toBe(1);
  });
});
