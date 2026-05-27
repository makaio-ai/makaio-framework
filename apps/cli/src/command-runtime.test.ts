import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockBus } from '@makaio/test-utils';
import {
  createProcessCommandContext,
  disconnectBusSafely,
  disposeResolvedBusForCommand,
  evaluateBeforeRunGate,
  getAuthorizedProvideBus,
  resolveContributionBus,
} from './command-runtime.js';
import { DEFAULT_CONNECTION_ERROR } from './connection-error.js';
import type { BeforeRunContext, CliContribution, EmbeddedBusHandle } from '@makaio/kernel/cli';

describe('resolveContributionBus', () => {
  it('returns external bus with no-op dispose and does NOT call provideBus', async () => {
    const { bus: externalBus } = createMockBus();
    const provideBus = vi.fn<NonNullable<CliContribution['provideBus']>>();

    const resolved = await resolveContributionBus(externalBus, provideBus, 'list', {}, '/cwd');

    expect(resolved.bus).toBe(externalBus);
    expect(provideBus).not.toHaveBeenCalled();
    // dispose must be callable and resolve without side effects
    await expect(resolved.dispose()).resolves.toBeUndefined();
  });

  it('uses the embedded handle when no external bus exists', async () => {
    const { bus: embeddedBus } = createMockBus();
    const dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const handle: EmbeddedBusHandle = { bus: embeddedBus, dispose };
    const provideBus = vi.fn<NonNullable<CliContribution['provideBus']>>().mockResolvedValue(handle);

    const resolved = await resolveContributionBus(null, provideBus, 'run', { env: 'prod' }, '/workspace');

    expect(resolved.bus).toBe(embeddedBus);
    expect(provideBus).toHaveBeenCalledWith({ subcommandName: 'run', args: { env: 'prod' }, cwd: '/workspace' });

    await resolved.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('returns null bus when provideBus returns null', async () => {
    const provideBus = vi.fn<NonNullable<CliContribution['provideBus']>>().mockResolvedValue(null);

    const resolved = await resolveContributionBus(null, provideBus, 'list', {}, '/cwd');

    expect(resolved.bus).toBeNull();
    await expect(resolved.dispose()).resolves.toBeUndefined();
  });

  it('returns null bus when neither external bus nor provideBus is present', async () => {
    const resolved = await resolveContributionBus(null, undefined, 'list', {}, '/cwd');

    expect(resolved.bus).toBeNull();
    await expect(resolved.dispose()).resolves.toBeUndefined();
  });
});

describe('disposeResolvedBusForCommand', () => {
  it('reports dispose failures without rejecting', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    process.exitCode = undefined;

    try {
      await expect(
        disposeResolvedBusForCommand({
          bus: null,
          async dispose() {
            throw new Error('shutdown failed');
          },
        }),
      ).resolves.toBeUndefined();

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Command failed'), 'shutdown failed');
      expect(process.exitCode).toBe(1);
    } finally {
      consoleErrorSpy.mockRestore();
      process.exitCode = undefined;
    }
  });
});

describe('getAuthorizedProvideBus', () => {
  it('returns provideBus when manifest and contribution both declare canProvideBus', () => {
    const provideBus = vi.fn<NonNullable<CliContribution['provideBus']>>();

    expect(getAuthorizedProvideBus({ canProvideBus: true, provideBus }, true)).toBe(provideBus);
  });

  it('returns undefined when contribution omits canProvideBus', () => {
    const provideBus = vi.fn<NonNullable<CliContribution['provideBus']>>();

    expect(getAuthorizedProvideBus({ provideBus }, true)).toBeUndefined();
  });

  it('returns undefined when the serializable manifest omits canProvideBus', () => {
    const provideBus = vi.fn<NonNullable<CliContribution['provideBus']>>();

    expect(getAuthorizedProvideBus({ canProvideBus: true, provideBus }, false)).toBeUndefined();
  });
});

describe('createProcessCommandContext', () => {
  let baselineListenerCount: number;

  beforeEach(() => {
    baselineListenerCount = process.listenerCount('SIGINT');
  });

  afterEach(() => {
    // Remove only listeners added during this test, not framework/Vitest ones.
    while (process.listenerCount('SIGINT') > baselineListenerCount) {
      const listeners = process.listeners('SIGINT');
      process.removeListener('SIGINT', listeners[listeners.length - 1] as NodeJS.SignalsListener);
    }
  });

  it('returns a context with the supplied args and bus', () => {
    const { bus } = createMockBus();
    const args = { profile: 'test' };

    const { context, cleanup } = createProcessCommandContext(args, bus);
    try {
      expect(context.args).toBe(args);
      expect(context.bus).toBe(bus);
    } finally {
      cleanup();
    }
  });

  it('aborts the signal when SIGINT is emitted', () => {
    const { bus } = createMockBus();
    const { context, cleanup } = createProcessCommandContext({}, bus);

    process.emit('SIGINT');
    // cleanup is safe to call even after signal fires
    cleanup();

    expect(context.signal.aborted).toBe(true);
  });

  it('does not install SIGTERM or SIGHUP listeners', () => {
    const { bus } = createMockBus();
    const sigtermBefore = process.listenerCount('SIGTERM');
    const sighupBefore = process.listenerCount('SIGHUP');
    const { cleanup } = createProcessCommandContext({}, bus);

    try {
      expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore);
      expect(process.listenerCount('SIGHUP')).toBe(sighupBefore);
    } finally {
      cleanup();
    }
  });

  it('cleanup() removes the SIGINT listener so subsequent signal does not abort', () => {
    const { bus } = createMockBus();
    const { context, cleanup } = createProcessCommandContext({}, bus);

    cleanup();
    // Emitting SIGINT after cleanup should not trigger the listener
    process.emit('SIGINT');

    expect(context.signal.aborted).toBe(false);
  });

  it('cleanup() is safe to call multiple times without throwing', () => {
    const { bus } = createMockBus();
    const { cleanup } = createProcessCommandContext({}, bus);

    expect(() => {
      cleanup();
      cleanup();
    }).not.toThrow();
  });

  it('registers output writers that forward to process streams', () => {
    const { bus } = createMockBus();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const { context, cleanup } = createProcessCommandContext({}, bus);
    try {
      context.output.write('hello');
      context.output.error('oops');

      expect(stdoutSpy).toHaveBeenCalledWith('hello');
      expect(stderrSpy).toHaveBeenCalledWith('oops');
    } finally {
      cleanup();
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('setExitCode() updates process.exitCode', () => {
    const { bus } = createMockBus();
    process.exitCode = undefined;
    const { context, cleanup } = createProcessCommandContext({}, bus);

    try {
      context.setExitCode(42);
      expect(process.exitCode).toBe(42);
    } finally {
      cleanup();
      process.exitCode = undefined;
    }
  });
});

describe('disconnectBusSafely', () => {
  it('does not warn when disconnect succeeds', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { bus } = createMockBus();

    try {
      expect(() => disconnectBusSafely(bus)).not.toThrow();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('swallows disconnect errors and logs a warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { bus } = createMockBus();
    vi.mocked(bus.disconnect).mockImplementation(() => {
      throw new Error('boom');
    });

    try {
      expect(() => disconnectBusSafely(bus)).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith('Failed to disconnect bus:', 'boom');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('swallows primitive disconnect throws and logs the raw value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { bus } = createMockBus();
    vi.mocked(bus.disconnect).mockImplementation(() => {
      throw 'boom';
    });

    try {
      expect(() => disconnectBusSafely(bus)).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith('Failed to disconnect bus:', 'boom');
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('evaluateBeforeRunGate', () => {
  const context: BeforeRunContext = {
    subcommandName: 'status',
    args: {},
    bus: null,
  };

  it('blocks malformed beforeRun results', async () => {
    const gate = await evaluateBeforeRunGate(() => ({ ok: true }), context, 'Bus unavailable');

    expect(gate).toEqual({
      allowed: false,
      message: 'beforeRun hook failed: hook returned an invalid result',
      exitCode: 1,
    });
  });

  it('allows when beforeRun returns { proceed: true }', async () => {
    const gate = await evaluateBeforeRunGate(() => ({ proceed: true }), context);

    expect(gate).toEqual({ allowed: true });
  });

  it('blocks when beforeRun returns { proceed: false, message }', async () => {
    const gate = await evaluateBeforeRunGate(() => ({ proceed: false, message: 'blocked' }), context);

    expect(gate).toEqual({ allowed: false, message: 'blocked', exitCode: 1 });
  });

  it('blocks with custom exitCode when beforeRun returns { proceed: false, message, exitCode }', async () => {
    const gate = await evaluateBeforeRunGate(() => ({ proceed: false, message: 'blocked', exitCode: 42 }), context);

    expect(gate).toEqual({ allowed: false, message: 'blocked', exitCode: 42 });
  });

  it('blocks when beforeRun throws, surfacing the error message', async () => {
    const gate = await evaluateBeforeRunGate(() => {
      throw new Error('hook exploded');
    }, context);

    expect(gate).toEqual({
      allowed: false,
      message: 'beforeRun hook failed: hook exploded',
      exitCode: 1,
    });
  });

  it('blocks with default connection error when no beforeRun and bus is null', async () => {
    const gate = await evaluateBeforeRunGate(undefined, context);

    expect(gate).toEqual({ allowed: false, message: DEFAULT_CONNECTION_ERROR, exitCode: 1 });
  });

  it('allows when no beforeRun and bus is non-null', async () => {
    const { bus } = createMockBus();
    const contextWithBus: BeforeRunContext = { ...context, bus };

    const gate = await evaluateBeforeRunGate(undefined, contextWithBus);

    expect(gate).toEqual({ allowed: true });
  });
});
