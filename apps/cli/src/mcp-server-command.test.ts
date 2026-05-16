/**
 * Tests for {@link registerMcpServerCommand}.
 *
 * Uses real Commander instances with `parseAsync()` driven via argv strings so
 * that CLI parsing is exercised end-to-end.
 *
 * The `startMcpBridge` function is mocked to avoid real stdio I/O — tests focus
 * on the CLI wiring: command registration, error handling when the bus is absent,
 * correct arguments forwarded to the bridge, and SIGINT → AbortController wiring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { createMockBus } from '@makaio/test-utils';
import { registerMcpServerCommand } from './mcp-server-command.js';
import type { McpServerCommandContext } from './mcp-server-command.js';

// ---------------------------------------------------------------------------
// Module mock — startMcpBridge
// ---------------------------------------------------------------------------

vi.mock('@makaio/app-mcp-server', () => ({
  startMcpBridge: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a fresh Commander program with `.exitOverride()` so that Commander
 * errors throw instead of calling `process.exit`, keeping tests isolated.
 */
function makeProgram(): InstanceType<typeof Command> {
  return new Command('makaio').exitOverride();
}

/**
 * Build a {@link McpServerCommandContext} backed by the supplied bus mock.
 * @param busOrNull - Connected bus mock, or `null` to simulate offline state.
 * @param connectionError - Optional human-readable connection error.
 */
function makeCtx(
  busOrNull: ReturnType<typeof createMockBus>['bus'] | null,
  connectionError?: string,
): McpServerCommandContext {
  return { bus: busOrNull, connectionError };
}

/**
 * Collect all string calls from a `process.stdout.write` or
 * `process.stderr.write` spy into a single concatenated string.
 * @param spy - The spy wrapping a write stream.
 * @returns Concatenated output string.
 */
function collectOutput(spy: ReturnType<typeof vi.spyOn>): string {
  return spy.mock.calls.map((c: [string | Uint8Array, ...unknown[]]) => String(c[0])).join('');
}

/**
 * Mute process I/O for the duration of a test and restore it afterwards.
 * @returns Spies for stdout/stderr and a `restore` callback for `afterEach`.
 */
function setupProcessIoSpies() {
  process.exitCode = undefined;
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  return {
    stdoutSpy,
    stderrSpy,
    restore: () => {
      process.exitCode = undefined;
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}

// ---------------------------------------------------------------------------
// Retrieve the vi.fn() handle to startMcpBridge for per-test assertions
// ---------------------------------------------------------------------------

async function getStartMcpBridgeMock(): Promise<ReturnType<typeof vi.fn>> {
  const mod = await import('@makaio/app-mcp-server');
  return mod.startMcpBridge as ReturnType<typeof vi.fn>;
}

// ---------------------------------------------------------------------------
// command registration
// ---------------------------------------------------------------------------

describe('registerMcpServerCommand — registration', () => {
  it('registers "mcp-server" as a top-level command', () => {
    const program = makeProgram();
    const { bus } = createMockBus();
    registerMcpServerCommand(program, makeCtx(bus));

    const names = program.commands.map((c) => c.name());
    expect(names).toContain('mcp-server');
  });

  it('registers "mcp-server" with a non-empty description', () => {
    const program = makeProgram();
    const { bus } = createMockBus();
    registerMcpServerCommand(program, makeCtx(bus));

    const cmd = program.commands.find((c) => c.name() === 'mcp-server');
    expect(cmd?.description()).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// offline / connection error
// ---------------------------------------------------------------------------

describe('registerMcpServerCommand — connection error', () => {
  let spies: ReturnType<typeof setupProcessIoSpies>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spies = setupProcessIoSpies();
    stderrSpy = spies.stderrSpy;
  });

  afterEach(() => {
    spies.restore();
  });

  it('sets exitCode=1 when bus is null', async () => {
    const program = makeProgram();
    registerMcpServerCommand(program, makeCtx(null));

    await program.parseAsync(['node', 'makaio', 'mcp-server']);

    expect(process.exitCode).toBe(1);
  });

  it('writes the supplied connection error to stderr when bus is null', async () => {
    const program = makeProgram();
    registerMcpServerCommand(program, makeCtx(null, 'server is offline'));

    await program.parseAsync(['node', 'makaio', 'mcp-server']);

    const errOutput = collectOutput(stderrSpy);
    expect(errOutput).toContain('server is offline');
  });

  it('writes the default connection error when no connectionError is supplied and bus is null', async () => {
    const program = makeProgram();
    registerMcpServerCommand(program, makeCtx(null));

    await program.parseAsync(['node', 'makaio', 'mcp-server']);

    const errOutput = collectOutput(stderrSpy);
    expect(errOutput).toContain('makaio serve');
  });
});

// ---------------------------------------------------------------------------
// bridge invocation
// ---------------------------------------------------------------------------

describe('registerMcpServerCommand — bridge invocation', () => {
  let spies: ReturnType<typeof setupProcessIoSpies>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spies = setupProcessIoSpies();
    stderrSpy = spies.stderrSpy;
  });

  afterEach(() => {
    spies.restore();
    vi.clearAllMocks();
  });

  it('calls startMcpBridge with the connected bus when the bus is available', async () => {
    const startMcpBridge = await getStartMcpBridgeMock();
    startMcpBridge.mockResolvedValue(undefined);

    const { bus } = createMockBus();
    const program = makeProgram();
    registerMcpServerCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'mcp-server']);

    expect(startMcpBridge).toHaveBeenCalledOnce();
    const [calledBus] = startMcpBridge.mock.calls[0] as [unknown, unknown];
    expect(calledBus).toBe(bus);
  });

  it('passes an AbortSignal in options to startMcpBridge', async () => {
    const startMcpBridge = await getStartMcpBridgeMock();
    startMcpBridge.mockResolvedValue(undefined);

    const { bus } = createMockBus();
    const program = makeProgram();
    registerMcpServerCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'mcp-server']);

    const [, opts] = startMcpBridge.mock.calls[0] as [unknown, { signal?: AbortSignal }];
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not set exitCode when startMcpBridge resolves normally', async () => {
    const startMcpBridge = await getStartMcpBridgeMock();
    startMcpBridge.mockResolvedValue(undefined);

    const { bus } = createMockBus();
    const program = makeProgram();
    registerMcpServerCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'mcp-server']);

    expect(process.exitCode).not.toBe(1);
  });

  it('sets exitCode=1 and writes to stderr when startMcpBridge rejects', async () => {
    const startMcpBridge = await getStartMcpBridgeMock();
    startMcpBridge.mockRejectedValue(new Error('bridge crashed'));

    const { bus } = createMockBus();
    const program = makeProgram();
    registerMcpServerCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'mcp-server']);

    expect(process.exitCode).toBe(1);
    const errOutput = collectOutput(stderrSpy);
    expect(errOutput).toContain('bridge crashed');
  });

  it('removes the SIGINT listener after startMcpBridge resolves', async () => {
    const startMcpBridge = await getStartMcpBridgeMock();
    startMcpBridge.mockResolvedValue(undefined);

    const { bus } = createMockBus();
    const program = makeProgram();
    registerMcpServerCommand(program, makeCtx(bus));

    const listenersBefore = process.listenerCount('SIGINT');
    await program.parseAsync(['node', 'makaio', 'mcp-server']);

    expect(process.listenerCount('SIGINT')).toBe(listenersBefore);
  });

  it('removes the SIGINT listener after startMcpBridge rejects', async () => {
    const startMcpBridge = await getStartMcpBridgeMock();
    startMcpBridge.mockRejectedValue(new Error('bridge crashed'));

    const { bus } = createMockBus();
    const program = makeProgram();
    registerMcpServerCommand(program, makeCtx(bus));

    const listenersBefore = process.listenerCount('SIGINT');
    await program.parseAsync(['node', 'makaio', 'mcp-server']);

    expect(process.listenerCount('SIGINT')).toBe(listenersBefore);
  });
});
