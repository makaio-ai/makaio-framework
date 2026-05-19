/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { createMockBus } from '@makaio/test-utils';
import { createProcessCommandContext, disconnectBusSafely, evaluateBeforeRunGate } from './command-runtime.js';
import type { BeforeRunContext } from '@makaio/kernel/cli';

describe('createProcessCommandContext', () => {
  let baselineListenerCount: number;

  beforeEach(() => {
    baselineListenerCount = process.listenerCount('SIGINT');
  });

  afterEach(() => {
    // Remove only SIGINT listeners added during this test, not framework/Vitest ones.
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
    const stdoutSpy = spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderrSpy = spyOn(process.stderr, 'write').mockReturnValue(true);

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
      expect(process.exitCode as number | undefined).toBe(42);
    } finally {
      cleanup();
      process.exitCode = undefined;
    }
  });
});

describe('disconnectBusSafely', () => {
  it('does not warn when disconnect succeeds', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    const { bus } = createMockBus();

    try {
      expect(() => disconnectBusSafely(bus)).not.toThrow();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('swallows disconnect errors and logs a warning', () => {
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    const { bus } = createMockBus();
    spyOn(bus, 'disconnect').mockImplementation(() => {
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
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => undefined);
    const { bus } = createMockBus();
    spyOn(bus, 'disconnect').mockImplementation(() => {
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
});
