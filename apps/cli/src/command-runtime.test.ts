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
  const commandAbortSignals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  const commandSignalExitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;
  let baselineListenerCounts: Record<(typeof commandAbortSignals)[number], number>;
  let baselineExitCode: typeof process.exitCode;

  beforeEach(() => {
    baselineListenerCounts = Object.fromEntries(
      commandAbortSignals.map((signal) => [signal, process.listenerCount(signal)]),
    ) as Record<(typeof commandAbortSignals)[number], number>;
    baselineExitCode = process.exitCode;
  });

  afterEach(() => {
    // Remove only listeners added during this test, not framework/Vitest ones.
    for (const signal of commandAbortSignals) {
      while (process.listenerCount(signal) > baselineListenerCounts[signal]) {
        const listeners = process.listeners(signal);
        process.removeListener(signal, listeners[listeners.length - 1] as NodeJS.SignalsListener);
      }
    }
    process.exitCode = baselineExitCode;
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

  it.each(commandAbortSignals)('aborts the signal when %s is emitted', (signal) => {
    const { bus } = createMockBus();
    const { context, cleanup } = createProcessCommandContext({}, bus);

    process.emit(signal);
    // cleanup is safe to call even after signal fires
    cleanup();

    expect(context.signal.aborted).toBe(true);
    expect(process.exitCode).toBe(commandSignalExitCodes[signal]);
  });

  it('removes sibling command signal listeners after the first abort', () => {
    const { bus } = createMockBus();
    const { context, cleanup } = createProcessCommandContext({}, bus);

    process.emit('SIGINT');
    cleanup();

    expect(context.signal.aborted).toBe(true);
    expect(process.exitCode).toBe(commandSignalExitCodes.SIGINT);
    for (const signal of commandAbortSignals) {
      expect(process.listenerCount(signal)).toBe(baselineListenerCounts[signal]);
    }
  });

  it('cleanup() removes all command signal listeners so subsequent signals do not abort', () => {
    const { bus } = createMockBus();
    const { context, cleanup } = createProcessCommandContext({}, bus);

    for (const signal of commandAbortSignals) {
      expect(process.listenerCount(signal)).toBe(baselineListenerCounts[signal] + 1);
    }

    cleanup();
    for (const signal of commandAbortSignals) {
      expect(process.listenerCount(signal)).toBe(baselineListenerCounts[signal]);
      process.emit(signal);
    }

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
