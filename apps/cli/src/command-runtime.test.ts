import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { resourceStepStopBudgetMs } from '@makaio/runtime-node';
import { createMockBus } from '@makaio/test-utils';
import { outerBoundMs } from '@makaio/utils';
import {
  createProcessCommandContext,
  createProcessCommandSignalContext,
  disconnectBusSafely,
  disposeResolvedBusForCommand,
  evaluateBeforeRunGate,
  getAuthorizedProvideBus,
  resolveContributionBus,
} from './command-runtime.js';
import { DEFAULT_CONNECTION_ERROR } from './connection-error.js';
import type { BeforeRunContext, CliContribution, EmbeddedBusHandle } from '@makaio/kernel/cli';

describe('resolveContributionBus', () => {
  /** Signal contexts created by a test; every one is finished so no listener outlives it. */
  const contexts: Array<ReturnType<typeof createProcessCommandSignalContext>> = [];
  const newSignalContext = (): ReturnType<typeof createProcessCommandSignalContext> => {
    const created = createProcessCommandSignalContext();
    contexts.push(created);
    return created;
  };

  let baselineExitCode: typeof process.exitCode;
  // A shutdown with a failed stage ends the process; the test observes that instead.
  let exit: MockInstance<typeof process.exit>;

  beforeEach(() => {
    baselineExitCode = process.exitCode;
    // The coordinator announces the shutdown a signal starts.
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as typeof process.exit);
  });

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map((created) => created.finish()));
    process.exitCode = baselineExitCode;
    vi.restoreAllMocks();
  });

  it('returns external bus with no-op dispose and does NOT call provideBus', async () => {
    const { bus: externalBus } = createMockBus();
    const provideBus = vi.fn<NonNullable<CliContribution['provideBus']>>();

    const resolved = await resolveContributionBus(externalBus, provideBus, 'list', {}, '/cwd', newSignalContext());

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
    const signalContext = newSignalContext();

    const resolved = await resolveContributionBus(
      null,
      provideBus,
      'run',
      { env: 'prod' },
      '/workspace',
      signalContext,
    );

    expect(resolved.bus).toBe(embeddedBus);
    expect(provideBus).toHaveBeenCalledWith({
      subcommandName: 'run',
      args: { env: 'prod' },
      cwd: '/workspace',
      signal: signalContext.signal,
      onStopBudget: signalContext.onStopBudget,
    });

    await resolved.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('disposes the embedded bus once when the signal shutdown and the command both dispose it', async () => {
    const { bus: embeddedBus } = createMockBus();
    const dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const provideBus = vi
      .fn<NonNullable<CliContribution['provideBus']>>()
      .mockResolvedValue({ bus: embeddedBus, dispose });
    const signalContext = newSignalContext();
    const resolved = await resolveContributionBus(null, provideBus, 'run', {}, '/cwd', signalContext);

    process.emit('SIGINT');
    // The handler has wound down: the shutdown stops the embedded bus on its own, and so does the command.
    signalContext.handlerSettled();
    await Promise.all([resolved.dispose(), signalContext.finish()]);

    expect(dispose).toHaveBeenCalledOnce();
  });

  it('stops an embedded bus that is still being provisioned when the signal arrives, once the provisioning settles', async () => {
    const { bus: embeddedBus } = createMockBus();
    const dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    let finishProvisioning!: (handle: EmbeddedBusHandle) => void;
    const provideBus = vi.fn<NonNullable<CliContribution['provideBus']>>().mockReturnValue(
      new Promise<EmbeddedBusHandle>((resolve) => {
        finishProvisioning = resolve;
      }),
    );
    const signalContext = newSignalContext();
    const resolving = resolveContributionBus(null, provideBus, 'run', {}, '/cwd', signalContext);

    process.emit('SIGTERM');
    finishProvisioning({ bus: embeddedBus, dispose });
    const resolved = await resolving;
    // No handler ever started, so none is waited for; the shutdown has stopped the bus by now.
    await signalContext.finish();

    expect(dispose).toHaveBeenCalledOnce();
    await resolved.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('does nothing for an embedded bus whose provisioning a signal cancelled cleanly', async () => {
    const provideBus = vi
      .fn<NonNullable<CliContribution['provideBus']>>()
      .mockImplementation(
        ({ signal }) =>
          new Promise<EmbeddedBusHandle>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
      );
    const signalContext = newSignalContext();
    const resolving = resolveContributionBus(null, provideBus, 'run', {}, '/cwd', signalContext);

    process.emit('SIGINT');
    await expect(resolving).rejects.toBe('SIGINT');

    await expect(signalContext.finish()).resolves.toBeUndefined();
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(130);
  });

  it('ends the shutdown with failure when the rollback of the provisioning a signal cancelled failed', async () => {
    const rollbackFailure = new Error('rollback failed');
    const provideBus = vi
      .fn<NonNullable<CliContribution['provideBus']>>()
      .mockImplementation(
        ({ signal }) =>
          new Promise<EmbeddedBusHandle>((_, reject) =>
            signal.addEventListener('abort', () =>
              reject(new AggregateError([rollbackFailure], 'boot rollback failed', { cause: signal.reason })),
            ),
          ),
      );
    const signalContext = newSignalContext();
    const resolving = resolveContributionBus(null, provideBus, 'run', {}, '/cwd', signalContext);

    process.emit('SIGINT');
    await expect(resolving).rejects.toBeInstanceOf(AggregateError);
    await signalContext.finish();

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Shutdown step "embedded runtime" did not complete cleanly'),
      expect.any(AggregateError),
    );
    expect(exit).toHaveBeenCalledWith(1);
    expect(process.exitCode).toBe(1);
  });

  it('bounds the stop of an embedded bus whose provider never reports a stop budget', async () => {
    vi.useFakeTimers();
    try {
      const provideBus = vi
        .fn<NonNullable<CliContribution['provideBus']>>()
        .mockReturnValue(new Promise<EmbeddedBusHandle>(() => undefined));
      const signalContext = newSignalContext();
      void resolveContributionBus(null, provideBus, 'run', {}, '/cwd', signalContext);

      process.emit('SIGINT');
      await vi.advanceTimersByTimeAsync(outerBoundMs(resourceStepStopBudgetMs()) + 2_000);

      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null bus when provideBus returns null', async () => {
    const provideBus = vi.fn<NonNullable<CliContribution['provideBus']>>().mockResolvedValue(null);

    const resolved = await resolveContributionBus(null, provideBus, 'list', {}, '/cwd', newSignalContext());

    expect(resolved.bus).toBeNull();
    await expect(resolved.dispose()).resolves.toBeUndefined();
  });

  it('returns null bus when neither external bus nor provideBus is present', async () => {
    const resolved = await resolveContributionBus(null, undefined, 'list', {}, '/cwd', newSignalContext());

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
    // The coordinator announces the shutdown it starts.
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
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
    vi.restoreAllMocks();
  });

  it('returns a context with the supplied args and bus', async () => {
    const { bus } = createMockBus();
    const args = { profile: 'test' };

    const { context, finish } = createProcessCommandContext(args, bus);
    try {
      expect(context.args).toBe(args);
      expect(context.bus).toBe(bus);
    } finally {
      await finish();
    }
  });

  it.each(commandAbortSignals)('aborts the signal with the name of %s and sets its exit code', async (signal) => {
    const { bus } = createMockBus();
    const { context, finish } = createProcessCommandContext({}, bus);

    process.emit(signal);
    await finish();

    expect(context.signal.aborted).toBe(true);
    expect(context.signal.reason).toBe(signal);
    expect(process.exitCode).toBe(commandSignalExitCodes[signal]);
  });

  it('keeps every signal listener while the command is still being wound down, so a later signal joins', async () => {
    const { bus } = createMockBus();
    const { context, finish } = createProcessCommandContext({}, bus);

    process.emit('SIGINT');
    // Each kind of signal arrives again while the command has not finished.
    process.emit('SIGINT');
    process.emit('SIGTERM');
    process.emit('SIGHUP');

    for (const signal of commandAbortSignals) {
      expect(process.listenerCount(signal)).toBe(baselineListenerCounts[signal] + 1);
    }
    // The first signal decided the abort and the exit code; later ones only joined.
    expect(context.signal.reason).toBe('SIGINT');
    expect(process.exitCode).toBe(commandSignalExitCodes.SIGINT);

    await finish();
    for (const signal of commandAbortSignals) {
      expect(process.listenerCount(signal)).toBe(baselineListenerCounts[signal]);
    }
  });

  it('finish() gives the signals back when no signal arrived, so later ones do not abort', async () => {
    const { bus } = createMockBus();
    const { context, finish } = createProcessCommandContext({}, bus);

    for (const signal of commandAbortSignals) {
      expect(process.listenerCount(signal)).toBe(baselineListenerCounts[signal] + 1);
    }

    await finish();
    for (const signal of commandAbortSignals) {
      expect(process.listenerCount(signal)).toBe(baselineListenerCounts[signal]);
    }

    expect(context.signal.aborted).toBe(false);
  });

  it('finish() is safe to call multiple times without throwing', async () => {
    const { bus } = createMockBus();
    const { finish } = createProcessCommandContext({}, bus);

    await finish();
    await expect(finish()).resolves.toBeUndefined();
  });

  it('registers output writers that forward to process streams', async () => {
    const { bus } = createMockBus();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const { context, finish } = createProcessCommandContext({}, bus);
    try {
      context.output.write('hello');
      context.output.error('oops');

      expect(stdoutSpy).toHaveBeenCalledWith('hello');
      expect(stderrSpy).toHaveBeenCalledWith('oops');
    } finally {
      await finish();
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('setExitCode() updates process.exitCode', async () => {
    const { bus } = createMockBus();
    process.exitCode = undefined;
    const { context, finish } = createProcessCommandContext({}, bus);

    try {
      context.setExitCode(42);
      expect(process.exitCode).toBe(42);
    } finally {
      await finish();
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
