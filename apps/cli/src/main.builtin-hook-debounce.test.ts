/**
 * Tests for the `--debounce-failure` cool-down applied to built-in hook
 * commands (`hook handle` and `hook received`) in {@link main}.
 *
 * The cool-down only skips the bus probe and connect — Commander still parses
 * argv and the hook action still runs with a `null` bus — so the assertions are
 * about *what was not called*, never about an early return.
 *
 * Kept in a sibling file because the primary main.test.ts already exceeds
 * the 800-line file-size guideline. The mocking setup is intentionally
 * minimal — only the modules touched by the cool-down path are stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExplicitDescriptorDiscovery } from '@makaio/runtime-node';
import type { ServeOptions } from './serve.js';

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede the import of the module under test
// ---------------------------------------------------------------------------

const busClientMocks = vi.hoisted(() => ({
  connectBusClient: vi.fn(),
  isAuthConnectionError: vi.fn(),
  probeHealth: vi.fn(),
  resolveClientAuth: vi.fn(),
  resolveBusUrl: vi.fn().mockReturnValue('ws://127.0.0.1:6252/bus'),
}));

const serveMocks = vi.hoisted(() => ({
  serve: vi.fn<(options: ServeOptions) => Promise<void>>(),
}));

const appLaunchMocks = vi.hoisted(() => ({
  launchAppAndWaitForBus: vi.fn().mockResolvedValue({ health: null, launched: false }),
}));

const warningDebounceMocks = vi.hoisted(() => ({
  // Hook cool-down functions (used by builtin-hook-debounce.ts).
  shouldSuppressHookCoolDown: vi.fn<() => boolean>(),
  recordHookCoolDown: vi.fn<() => void>(),
  // Warning functions (still exported; must not be called by the hook path).
  shouldSuppressWarning: vi.fn<() => boolean>(),
  recordWarningShown: vi.fn<() => void>(),
}));

vi.mock('./bus-client.js', () => busClientMocks);
vi.mock('./serve.js', () => serveMocks);
vi.mock('./app-launch.js', () => appLaunchMocks);
vi.mock('./warning-debounce.js', () => warningDebounceMocks);

import { main } from './main.js';
import { isBuiltinHookInvocation, shouldSkipBusProbe } from './builtin-hook-debounce.js';

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

const emptyDiscovery = new ExplicitDescriptorDiscovery([]);

const BUS_URL = 'ws://127.0.0.1:6252/bus';

/**
 * Run `main` with `process.stdin` reported as a TTY so the hook action's own
 * stdin read resolves immediately instead of waiting for a pipe to close.
 * @param argv - Full argv vector passed to {@link main}.
 */
async function runMainWithTtyStdin(argv: readonly string[]): Promise<void> {
  const original = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  try {
    await main([...argv], [], emptyDiscovery);
  } finally {
    if (original) {
      Object.defineProperty(process.stdin, 'isTTY', original);
    } else {
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  }
}

// ---------------------------------------------------------------------------
// isBuiltinHookInvocation — coarse command/subcommand check only
// ---------------------------------------------------------------------------

describe('isBuiltinHookInvocation', () => {
  it('returns true for hook handle regardless of the operand tail', () => {
    expect(isBuiltinHookInvocation(['node', 'makaio', 'hook', 'handle'])).toBe(true);
    expect(isBuiltinHookInvocation(['node', 'makaio', 'hook', 'handle', 'claude-code', 'PreToolUse'])).toBe(true);
    expect(
      isBuiltinHookInvocation(['node', 'makaio', 'hook', 'handle', 'claude-code', 'PreToolUse', '--timeout=1000']),
    ).toBe(true);
  });

  it('returns true for hook received regardless of the operand tail', () => {
    expect(isBuiltinHookInvocation(['node', 'makaio', 'hook', 'received', 'claude-code', 'Stop'])).toBe(true);
    expect(isBuiltinHookInvocation(['node', 'makaio', 'hook', 'received', '--metadata-json={}'])).toBe(true);
  });

  it('returns false when argv[2] is not hook', () => {
    expect(isBuiltinHookInvocation(['node', 'makaio', 'serve'])).toBe(false);
  });

  it('returns false for an unknown hook subcommand or a missing one', () => {
    expect(isBuiltinHookInvocation(['node', 'makaio', 'hook', 'unknown', 'claude-code', 'Stop'])).toBe(false);
    expect(isBuiltinHookInvocation(['node', 'makaio', 'hook'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldSkipBusProbe
// ---------------------------------------------------------------------------

describe('shouldSkipBusProbe', () => {
  afterEach(() => {
    warningDebounceMocks.shouldSuppressHookCoolDown.mockReset();
  });

  it('skips the probe for a hook handle invocation inside the cool-down', () => {
    warningDebounceMocks.shouldSuppressHookCoolDown.mockReturnValue(true);
    const argv = ['node', 'makaio', 'hook', 'handle', 'claude-code', 'PreToolUse', '--timeout', '5000'];
    expect(shouldSkipBusProbe(argv, true, BUS_URL)).toBe(true);
  });

  it('skips the probe for a hook received invocation inside the cool-down', () => {
    warningDebounceMocks.shouldSuppressHookCoolDown.mockReturnValue(true);
    expect(shouldSkipBusProbe(['node', 'makaio', 'hook', 'received', 'claude-code', 'Stop'], true, BUS_URL)).toBe(true);
  });

  it('skips the probe for argv spellings a hand-rolled grammar would miss', () => {
    // Attached option values, unknown options and malformed values are all
    // Commander's business now; skipping the probe cannot change its verdict.
    warningDebounceMocks.shouldSuppressHookCoolDown.mockReturnValue(true);
    for (const tail of [['--timeout=1000'], ['--metadata-json={}'], ['--timeout', 'nope'], ['--bogus']]) {
      const argv = ['node', 'makaio', 'hook', 'handle', 'claude-code', 'PreToolUse', ...tail];
      expect(shouldSkipBusProbe(argv, true, BUS_URL)).toBe(true);
    }
  });

  it('never skips the probe for a --fail-close invocation', () => {
    warningDebounceMocks.shouldSuppressHookCoolDown.mockReturnValue(true);
    const argv = ['node', 'makaio', 'hook', 'handle', 'claude-code', 'PreToolUse', '--fail-close', '--timeout', '5000'];
    expect(shouldSkipBusProbe(argv, true, BUS_URL)).toBe(false);
    expect(warningDebounceMocks.shouldSuppressHookCoolDown).not.toHaveBeenCalled();
  });

  it('never skips the probe without --debounce-failure', () => {
    warningDebounceMocks.shouldSuppressHookCoolDown.mockReturnValue(true);
    const argv = ['node', 'makaio', 'hook', 'handle', 'claude-code', 'PreToolUse'];
    expect(shouldSkipBusProbe(argv, false, BUS_URL)).toBe(false);
    expect(warningDebounceMocks.shouldSuppressHookCoolDown).not.toHaveBeenCalled();
  });

  it('never skips the probe for a non-hook command', () => {
    warningDebounceMocks.shouldSuppressHookCoolDown.mockReturnValue(true);
    expect(shouldSkipBusProbe(['node', 'makaio', 'serve'], true, BUS_URL)).toBe(false);
    expect(warningDebounceMocks.shouldSuppressHookCoolDown).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// main — cool-down skips probe + connect, Commander still runs
// ---------------------------------------------------------------------------

describe('main — builtin hook cool-down', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    busClientMocks.resolveBusUrl.mockReturnValue(BUS_URL);
    busClientMocks.probeHealth.mockResolvedValue(null);
    appLaunchMocks.launchAppAndWaitForBus.mockResolvedValue({ health: null, launched: false });
    warningDebounceMocks.shouldSuppressHookCoolDown.mockReturnValue(false);
    warningDebounceMocks.recordHookCoolDown.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('skips probe and connect for hook handle inside the cool-down but still runs the action', async () => {
    warningDebounceMocks.shouldSuppressHookCoolDown.mockReturnValue(true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await runMainWithTtyStdin([
      'node',
      'makaio',
      '--debounce-failure',
      '--no-launch',
      'hook',
      'handle',
      'claude-code',
      'PreToolUse',
    ]);

    expect(busClientMocks.probeHealth).not.toHaveBeenCalled();
    expect(busClientMocks.connectBusClient).not.toHaveBeenCalled();
    // Documented fail-open shape of runClientHookHandleCommand on a null bus.
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('skips probe and connect for hook received inside the cool-down', async () => {
    warningDebounceMocks.shouldSuppressHookCoolDown.mockReturnValue(true);

    await runMainWithTtyStdin([
      'node',
      'makaio',
      '--debounce-failure',
      '--no-launch',
      'hook',
      'received',
      'claude-code',
      'Stop',
    ]);

    expect(busClientMocks.probeHealth).not.toHaveBeenCalled();
    expect(busClientMocks.connectBusClient).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('still probes for a --fail-close invocation inside the cool-down', async () => {
    warningDebounceMocks.shouldSuppressHookCoolDown.mockReturnValue(true);

    await runMainWithTtyStdin([
      'node',
      'makaio',
      '--debounce-failure',
      '--no-launch',
      'hook',
      'handle',
      'claude-code',
      'PreToolUse',
      '--fail-close',
    ]);

    expect(busClientMocks.probeHealth).toHaveBeenCalled();
    // The bus really is down and --fail-close must fail loudly.
    expect(process.exitCode).toBe(1);
  });

  it('does not refresh the marker when the probe was skipped by the cool-down', async () => {
    // Otherwise every hook inside the window would extend it indefinitely.
    warningDebounceMocks.shouldSuppressHookCoolDown.mockReturnValue(true);

    await runMainWithTtyStdin([
      'node',
      'makaio',
      '--debounce-failure',
      '--no-launch',
      'hook',
      'handle',
      'claude-code',
      'PreToolUse',
    ]);

    expect(warningDebounceMocks.recordHookCoolDown).not.toHaveBeenCalled();
  });

  it('does not consult the cool-down when --debounce-failure is absent', async () => {
    await runMainWithTtyStdin(['node', 'makaio', '--no-launch', 'hook', 'handle', 'claude-code', 'Stop']);

    expect(warningDebounceMocks.shouldSuppressHookCoolDown).not.toHaveBeenCalled();
    expect(busClientMocks.probeHealth).toHaveBeenCalled();
  });

  it('lets Commander render help for hook handle --help inside the cool-down', async () => {
    warningDebounceMocks.shouldSuppressHookCoolDown.mockReturnValue(true);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    await runMainWithTtyStdin(['node', 'makaio', '--debounce-failure', '--no-launch', 'hook', 'handle', '--help']);

    const stdout = stdoutSpy.mock.calls.map(([chunk]) => String(chunk)).join('');
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('hook handle');
    expect(stderrSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it('records a cool-down marker after hook handle ran with an unreachable server', async () => {
    await runMainWithTtyStdin([
      'node',
      'makaio',
      '--debounce-failure',
      '--no-launch',
      'hook',
      'handle',
      'claude-code',
      'Stop',
    ]);

    expect(warningDebounceMocks.recordHookCoolDown).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it('records a cool-down marker after hook received ran with an unreachable server', async () => {
    await runMainWithTtyStdin([
      'node',
      'makaio',
      '--debounce-failure',
      '--no-launch',
      'hook',
      'received',
      'claude-code',
      'Stop',
    ]);

    expect(warningDebounceMocks.recordHookCoolDown).toHaveBeenCalledOnce();
    expect(process.exitCode).toBeUndefined();
  });

  it('records a cool-down marker when the connection fails for a transport reason', async () => {
    // A health probe success followed by a non-auth WebSocket failure (e.g.
    // server exited between the probe and the open) carries the same
    // per-invocation cost as an unreachable server.
    busClientMocks.probeHealth.mockResolvedValue({ auth: false });
    busClientMocks.resolveClientAuth.mockReturnValue(undefined);
    busClientMocks.connectBusClient.mockRejectedValue(new Error('ECONNRESET'));
    busClientMocks.isAuthConnectionError.mockReturnValue(false);

    await runMainWithTtyStdin([
      'node',
      'makaio',
      '--debounce-failure',
      '--no-launch',
      'hook',
      'handle',
      'claude-code',
      'Stop',
    ]);

    expect(warningDebounceMocks.recordHookCoolDown).toHaveBeenCalledOnce();
  });

  it('does not record a cool-down marker when the connection fails for an auth reason', async () => {
    // Auth failures are configuration problems: recording them would keep
    // suppressing hooks after the operator fixes the secret.
    busClientMocks.probeHealth.mockResolvedValue({ auth: true });
    busClientMocks.resolveClientAuth.mockReturnValue(undefined);
    busClientMocks.connectBusClient.mockRejectedValue(new Error('unauthorized'));
    busClientMocks.isAuthConnectionError.mockReturnValue(true);

    await runMainWithTtyStdin([
      'node',
      'makaio',
      '--debounce-failure',
      '--no-launch',
      'hook',
      'handle',
      'claude-code',
      'Stop',
    ]);

    expect(warningDebounceMocks.recordHookCoolDown).not.toHaveBeenCalled();
  });

  it('does not record a cool-down marker when hook handle runs with a live bus', async () => {
    const { createMockBus } = await import('@makaio/test-utils');
    const { bus } = createMockBus();
    busClientMocks.probeHealth.mockResolvedValue({ auth: false });
    busClientMocks.resolveClientAuth.mockReturnValue(undefined);
    busClientMocks.connectBusClient.mockResolvedValue(bus);
    vi.mocked(bus.request).mockResolvedValue({ contributions: [] });

    await runMainWithTtyStdin([
      'node',
      'makaio',
      '--debounce-failure',
      '--no-launch',
      'hook',
      'handle',
      'claude-code',
      'Stop',
    ]);

    expect(warningDebounceMocks.recordHookCoolDown).not.toHaveBeenCalled();
  });
});
