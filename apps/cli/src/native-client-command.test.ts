/**
 * Tests for {@link registerNativeClientCommand}.
 *
 * Uses real Commander instances with `parseAsync()` driven via argv strings so
 * that CLI parsing is exercised end-to-end.
 *
 * Two test layers are provided:
 * - **Unit tests** (most describe blocks): bus interaction is provided through
 *   `createMockBus()`, keeping these tests focused on CLI arg parsing and bus
 *   request payload construction.
 * - **Integration tests** (`integration — real bus round-trip`): a real
 *   in-process `createBusInstance()` bus is wired with stub handlers to verify
 *   the full path from argv → Commander → bus request → handler → formatted
 *   output without any mocking of the bus layer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { NativeSessionSupervisorSubjects } from '@makaio/contracts';
import { createMockBus } from '@makaio/test-utils';
import { createBusInstance } from '@makaio/bus-core';
import {
  buildAttachRequest,
  registerNativeClientCommand,
  resolveNativeClientDefinition,
} from './native-client-command.js';
import type { NativeClientCliDefinition, NativeClientCommandContext } from './native-client-command.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal client list used in tests that exercise top-level shortcut behavior.
 * Kept here (not imported from main.ts) so the test fixture stays independent
 * of the composition root's app-owned shortcut list.
 */
const TEST_CLIENTS: readonly NativeClientCliDefinition[] = [
  { clientId: 'claude-code', command: 'claude', displayName: 'Claude Code' },
  { clientId: 'codex', command: 'codex', displayName: 'Codex' },
];

/**
 * Create a fresh Commander program with `.exitOverride()` so that Commander
 * errors throw instead of calling `process.exit`, keeping tests isolated.
 */
function makeProgram(): InstanceType<typeof Command> {
  return new Command('makaio').exitOverride();
}

/**
 * Build a {@link NativeClientCommandContext} backed by the supplied bus mock.
 * @param busOrNull - Connected bus mock, or `null` to simulate offline state.
 * @param connectionError - Optional human-readable connection error.
 * @param clients - Client bootstrapping table; defaults to {@link TEST_CLIENTS}.
 */
function makeCtx(
  busOrNull: ReturnType<typeof createMockBus>['bus'] | null,
  connectionError?: string,
  clients: readonly NativeClientCliDefinition[] = TEST_CLIENTS,
): NativeClientCommandContext {
  return { bus: busOrNull, connectionError, clients };
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
// buildAttachRequest
// ---------------------------------------------------------------------------

describe('buildAttachRequest', () => {
  it('returns a supervisorSessionId locator when provided', () => {
    const result = buildAttachRequest('sup-123', undefined, undefined);
    expect(result).toStrictEqual({ ok: true, request: { supervisorSessionId: 'sup-123' } });
  });

  it('returns a sessionId locator when supervisorSessionId is absent', () => {
    const result = buildAttachRequest(undefined, 'sess-456', undefined);
    expect(result).toStrictEqual({ ok: true, request: { sessionId: 'sess-456' } });
  });

  it('returns an adapterSessionId locator as the last fallback', () => {
    const result = buildAttachRequest(undefined, undefined, 'adapter-789');
    expect(result).toStrictEqual({ ok: true, request: { adapterSessionId: 'adapter-789' } });
  });

  it('returns reason "none" when no locator is supplied', () => {
    const result = buildAttachRequest(undefined, undefined, undefined);
    expect(result).toStrictEqual({ ok: false, reason: 'none' });
  });

  it('returns reason "multiple" when two locators are provided together', () => {
    const result = buildAttachRequest('sup-1', 'sess-2', undefined);
    expect(result).toStrictEqual({ ok: false, reason: 'multiple' });
  });

  it('returns reason "multiple" when all three locators are provided', () => {
    const result = buildAttachRequest('sup-1', 'sess-2', 'adapter-3');
    expect(result).toStrictEqual({ ok: false, reason: 'multiple' });
  });
});

// ---------------------------------------------------------------------------
// resolveNativeClientDefinition
// ---------------------------------------------------------------------------

describe('resolveNativeClientDefinition', () => {
  it('uses the declared binary name for known clients', () => {
    expect(resolveNativeClientDefinition('claude-code', TEST_CLIENTS)).toMatchObject({
      clientId: 'claude-code',
      command: 'claude',
    });
  });

  it('falls back to the client ID for generic client management', () => {
    expect(resolveNativeClientDefinition('custom-client', TEST_CLIENTS)).toMatchObject({
      clientId: 'custom-client',
      command: 'custom-client',
    });
  });
});

// ---------------------------------------------------------------------------
// launch subcommand
// ---------------------------------------------------------------------------

describe('registerNativeClientCommand — launch', () => {
  let spies: ReturnType<typeof setupProcessIoSpies>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spies = setupProcessIoSpies();
    stdoutSpy = spies.stdoutSpy;
    stderrSpy = spies.stderrSpy;
  });

  afterEach(() => {
    spies.restore();
  });

  it('calls supervisor launch subject with clientId, cwd, and empty args', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ supervisorSessionId: 'sup-abc', pid: 1234 });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'launch', 'claude-code']);

    expect(request).toHaveBeenCalledWith(NativeSessionSupervisorSubjects.launch, {
      clientId: 'claude-code',
      cwd: process.cwd(),
      command: 'claude',
      args: [],
    });
  });

  it('prints the supervisor session ID and pid on success', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ supervisorSessionId: 'sup-abc', pid: 1234 });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'launch', 'claude-code']);

    const output = collectOutput(stdoutSpy);
    expect(output).toContain('sup-abc');
    expect(output).toContain('1234');
  });

  it('writes an error to stderr and sets exitCode=1 when the bus request rejects', async () => {
    const { bus, request } = createMockBus();
    request.mockRejectedValue(new Error('supervisor unavailable'));

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'launch', 'claude-code']);

    expect(process.exitCode).toBe(1);
    const errOutput = collectOutput(stderrSpy);
    expect(errOutput).toContain('supervisor unavailable');
  });

  it('writes a connection error to stderr when bus is null', async () => {
    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(null, 'server is offline'));

    await program.parseAsync(['node', 'makaio', 'client', 'launch', 'claude-code']);

    expect(process.exitCode).toBe(1);
    const errOutput = collectOutput(stderrSpy);
    expect(errOutput).toContain('server is offline');
  });
});

// ---------------------------------------------------------------------------
// top-level native client shortcut
// ---------------------------------------------------------------------------

describe('registerNativeClientCommand — top-level client shortcut', () => {
  let spies: ReturnType<typeof setupProcessIoSpies>;

  beforeEach(() => {
    spies = setupProcessIoSpies();
  });

  afterEach(() => {
    spies.restore();
  });

  it('launches a known client from `makaio <client>` using its binary name', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ supervisorSessionId: 'sup-abc', pid: 1234 });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'claude-code']);

    expect(request).toHaveBeenCalledWith(NativeSessionSupervisorSubjects.launch, {
      clientId: 'claude-code',
      cwd: process.cwd(),
      command: 'claude',
      args: [],
    });
  });

  it('supports attach under the top-level client command', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ success: true, supervisorSessionId: 'sup-abc' });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'claude-code', 'attach', '--session', 'sess-123']);

    expect(request).toHaveBeenCalledWith(NativeSessionSupervisorSubjects.attach, { sessionId: 'sess-123' });
  });
});

// ---------------------------------------------------------------------------
// attach subcommand
// ---------------------------------------------------------------------------

describe('registerNativeClientCommand — attach', () => {
  let spies: ReturnType<typeof setupProcessIoSpies>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spies = setupProcessIoSpies();
    stdoutSpy = spies.stdoutSpy;
    stderrSpy = spies.stderrSpy;
  });

  afterEach(() => {
    spies.restore();
  });

  it('attaches by positional supervisor session ID', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ success: true, supervisorSessionId: 'sup-abc', pid: 5678 });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'attach', 'sup-abc']);

    expect(request).toHaveBeenCalledWith(NativeSessionSupervisorSubjects.attach, { supervisorSessionId: 'sup-abc' });
  });

  it('attaches by --session flag', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ success: true, supervisorSessionId: 'sup-abc' });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'attach', '--session', 'sess-123']);

    expect(request).toHaveBeenCalledWith(NativeSessionSupervisorSubjects.attach, { sessionId: 'sess-123' });
  });

  it('attaches by --adapter-session flag', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ success: true });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'attach', '--adapter-session', 'adapter-xyz']);

    expect(request).toHaveBeenCalledWith(NativeSessionSupervisorSubjects.attach, { adapterSessionId: 'adapter-xyz' });
  });

  it('sets exitCode=1 and writes to stderr when no locator is supplied', async () => {
    const { bus } = createMockBus();

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'attach']);

    expect(process.exitCode).toBe(1);
    const errOutput = collectOutput(stderrSpy);
    expect(errOutput).toContain('requires exactly one locator');
  });

  it('sets exitCode=1 and writes to stderr when multiple locators are supplied', async () => {
    const { bus } = createMockBus();

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'attach', 'sup-abc', '--session', 'sess-123']);

    expect(process.exitCode).toBe(1);
    const errOutput = collectOutput(stderrSpy);
    expect(errOutput).toContain('multiple locators');
  });

  it('prints attach result details on success', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({
      success: true,
      supervisorSessionId: 'sup-abc',
      pid: 9999,
      terminalAttachment: { canAttach: true },
    });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'attach', 'sup-abc']);

    const output = collectOutput(stdoutSpy);
    expect(output).toContain('sup-abc');
    expect(output).toContain('9999');
    expect(output).toContain('true');
  });

  it('sets exitCode=1 when attach response indicates failure', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ success: false });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'attach', 'sup-missing']);

    expect(process.exitCode).toBe(1);
    const errOutput = collectOutput(stderrSpy);
    expect(errOutput).toContain('not found');
  });

  it('sets exitCode=1 when bus is null', async () => {
    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(null, 'offline'));

    await program.parseAsync(['node', 'makaio', 'client', 'attach', 'sup-abc']);

    expect(process.exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// stop subcommand
// ---------------------------------------------------------------------------

describe('registerNativeClientCommand — stop', () => {
  let spies: ReturnType<typeof setupProcessIoSpies>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spies = setupProcessIoSpies();
    stdoutSpy = spies.stdoutSpy;
  });

  afterEach(() => {
    spies.restore();
  });

  it('sends stop request with supervisor session ID', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ success: true });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'stop', 'sup-abc']);

    expect(request).toHaveBeenCalledWith(NativeSessionSupervisorSubjects.stop, {
      supervisorSessionId: 'sup-abc',
    });
  });

  it('forwards --signal when provided', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ success: true });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'stop', 'sup-abc', '--signal', 'SIGKILL']);

    expect(request).toHaveBeenCalledWith(NativeSessionSupervisorSubjects.stop, {
      supervisorSessionId: 'sup-abc',
      signal: 'SIGKILL',
    });
  });

  it('prints confirmation on success', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ success: true });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'stop', 'sup-abc']);

    const output = collectOutput(stdoutSpy);
    expect(output).toContain('sup-abc');
  });

  it('sets exitCode=1 when stop response indicates failure', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ success: false });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'stop', 'sup-abc']);

    expect(process.exitCode).toBe(1);
  });

  it('sets exitCode=1 when bus is null', async () => {
    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(null));

    await program.parseAsync(['node', 'makaio', 'client', 'stop', 'sup-abc']);

    expect(process.exitCode).toBe(1);
  });

  it('sets exitCode=1 and writes to stderr when the stop bus request rejects', async () => {
    // Exercises the try/catch path in handleStop(): a rejected bus.request()
    // must set exitCode=1 and write the error message to stderr, not propagate
    // the exception to the Commander action handler.
    const { bus, request } = createMockBus();
    request.mockRejectedValue(new Error('supervisor crashed'));

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'stop', 'sup-abc']);

    expect(process.exitCode).toBe(1);
    const errOutput = collectOutput(spies.stderrSpy);
    expect(errOutput).toContain('supervisor crashed');
  });
});

// ---------------------------------------------------------------------------
// status subcommand
// ---------------------------------------------------------------------------

describe('registerNativeClientCommand — status', () => {
  let spies: ReturnType<typeof setupProcessIoSpies>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spies = setupProcessIoSpies();
    stdoutSpy = spies.stdoutSpy;
    stderrSpy = spies.stderrSpy;
  });

  afterEach(() => {
    spies.restore();
  });

  it('sends a status request with no filters when no ID is given', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ runtimes: [] });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'status']);

    expect(request).toHaveBeenCalledWith(NativeSessionSupervisorSubjects.status, {});
  });

  it('sends a filtered status request when a supervisor session ID is given', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ runtimes: [] });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'status', 'sup-abc']);

    expect(request).toHaveBeenCalledWith(NativeSessionSupervisorSubjects.status, {
      supervisorSessionId: 'sup-abc',
    });
  });

  it('prints "No supervised runtimes found" when runtimes is empty', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({ runtimes: [] });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'status']);

    const output = collectOutput(stdoutSpy);
    expect(output).toContain('No supervised runtimes found');
  });

  it('prints runtime snapshot details for each returned runtime', async () => {
    const { bus, request } = createMockBus();
    const runtime = {
      supervisorSessionId: 'sup-abc',
      clientId: 'claude-code',
      pid: 1234,
      status: 'running' as const,
      cwd: '/home/user/project',
      startedAt: 1700000000000,
    };
    request.mockResolvedValue({ runtimes: [runtime] });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'status']);

    const output = collectOutput(stdoutSpy);
    expect(output).toContain('sup-abc');
    expect(output).toContain('claude-code');
    expect(output).toContain('1234');
    expect(output).toContain('running');
  });

  it('prints the session ID when present in the snapshot', async () => {
    const { bus, request } = createMockBus();
    request.mockResolvedValue({
      runtimes: [
        {
          supervisorSessionId: 'sup-1',
          clientId: 'cursor',
          pid: null,
          status: 'exited' as const,
          cwd: '/tmp',
          startedAt: 0,
          sessionId: 'session-xyz',
        },
      ],
    });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'status']);

    const output = collectOutput(stdoutSpy);
    expect(output).toContain('session-xyz');
  });

  it('sets exitCode=1 when bus is null', async () => {
    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(null));

    await program.parseAsync(['node', 'makaio', 'client', 'status']);

    expect(process.exitCode).toBe(1);
  });

  it('sets exitCode=1 when the status request rejects', async () => {
    const { bus, request } = createMockBus();
    request.mockRejectedValue(new Error('bus error'));

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'status']);

    expect(process.exitCode).toBe(1);
    const errOutput = collectOutput(stderrSpy);
    expect(errOutput).toContain('bus error');
  });
});

// ---------------------------------------------------------------------------
// integration — real bus round-trip
// ---------------------------------------------------------------------------

/**
 * Integration tests that wire a real in-process bus with stub request handlers.
 *
 * These tests verify the full path: argv string → Commander parsing →
 * bus.request() → handler execution → formatted stdout/stderr output.
 * The bus is created fresh per test via `createBusInstance()` and receives
 * lightweight stub handlers that return valid response shapes — no service
 * implementations, no network I/O.
 */
describe('integration — real bus round-trip', () => {
  let spies: ReturnType<typeof setupProcessIoSpies>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    spies = setupProcessIoSpies();
    stdoutSpy = spies.stdoutSpy;
  });

  afterEach(() => {
    spies.restore();
  });

  it('launch: handler receives correct payload and CLI prints supervisorSessionId', async () => {
    const bus = createBusInstance();
    let capturedPayload: unknown;

    const cleanup = bus.on(NativeSessionSupervisorSubjects.launch, (ctx) => {
      capturedPayload = ctx.payload;
      ctx.setResult({ supervisorSessionId: 'real-sup-001', pid: 4242 });
    });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'launch', 'claude-code']);

    cleanup();

    expect(capturedPayload).toStrictEqual({
      clientId: 'claude-code',
      cwd: process.cwd(),
      command: 'claude',
      args: [],
    });

    const output = collectOutput(stdoutSpy);
    expect(output).toContain('real-sup-001');
    expect(output).toContain('4242');
  });

  it('launch: forwards --profile through a real bus request', async () => {
    const bus = createBusInstance();
    let capturedPayload: unknown;

    const cleanup = bus.on(NativeSessionSupervisorSubjects.launch, (ctx) => {
      capturedPayload = ctx.payload;
      ctx.setResult({ supervisorSessionId: 'real-sup-profile-001', pid: 4243 });
    });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'launch', 'claude-code', '--profile', 'work']);

    cleanup();

    expect(capturedPayload).toStrictEqual({
      clientId: 'claude-code',
      cwd: process.cwd(),
      command: 'claude',
      args: [],
      clientProfileName: 'work',
    });
  });

  it('top-level shortcut: forwards --profile through a real bus request', async () => {
    const bus = createBusInstance();
    let capturedPayload: unknown;

    const cleanup = bus.on(NativeSessionSupervisorSubjects.launch, (ctx) => {
      capturedPayload = ctx.payload;
      ctx.setResult({ supervisorSessionId: 'real-sup-profile-002', pid: 4244 });
    });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'claude-code', '--profile', 'work']);

    cleanup();

    expect(capturedPayload).toStrictEqual({
      clientId: 'claude-code',
      cwd: process.cwd(),
      command: 'claude',
      args: [],
      clientProfileName: 'work',
    });
  });

  it('attach: handler receives supervisorSessionId locator and CLI prints confirmation', async () => {
    const bus = createBusInstance();
    let capturedPayload: unknown;

    const cleanup = bus.on(NativeSessionSupervisorSubjects.attach, (ctx) => {
      capturedPayload = ctx.payload;
      ctx.setResult({
        success: true,
        supervisorSessionId: 'real-sup-002',
        pid: 5555,
        terminalAttachment: { canAttach: true },
      });
    });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'attach', 'real-sup-002']);

    cleanup();

    expect(capturedPayload).toStrictEqual({ supervisorSessionId: 'real-sup-002' });

    const output = collectOutput(stdoutSpy);
    expect(output).toContain('real-sup-002');
    expect(output).toContain('5555');
    expect(output).toContain('true');
  });

  it('stop: handler receives supervisorSessionId and CLI prints confirmation', async () => {
    const bus = createBusInstance();
    let capturedPayload: unknown;

    const cleanup = bus.on(NativeSessionSupervisorSubjects.stop, (ctx) => {
      capturedPayload = ctx.payload;
      ctx.setResult({ success: true });
    });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'stop', 'real-sup-003']);

    cleanup();

    expect(capturedPayload).toStrictEqual({ supervisorSessionId: 'real-sup-003' });

    const output = collectOutput(stdoutSpy);
    expect(output).toContain('real-sup-003');
  });

  it('status: handler receives empty filter and CLI lists returned runtime', async () => {
    const bus = createBusInstance();
    let capturedPayload: unknown;

    const runtime = {
      supervisorSessionId: 'real-sup-004',
      clientId: 'claude-code',
      pid: 6789,
      status: 'running' as const,
      cwd: '/home/user/project',
      startedAt: 1_700_000_000_000,
    };

    const cleanup = bus.on(NativeSessionSupervisorSubjects.status, (ctx) => {
      capturedPayload = ctx.payload;
      ctx.setResult({ runtimes: [runtime] });
    });

    const program = makeProgram();
    registerNativeClientCommand(program, makeCtx(bus));

    await program.parseAsync(['node', 'makaio', 'client', 'status']);

    cleanup();

    expect(capturedPayload).toStrictEqual({});

    const output = collectOutput(stdoutSpy);
    expect(output).toContain('real-sup-004');
    expect(output).toContain('claude-code');
    expect(output).toContain('6789');
    expect(output).toContain('running');
  });
});
