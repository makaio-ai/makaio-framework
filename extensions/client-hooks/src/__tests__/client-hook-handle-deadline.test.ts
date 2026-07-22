/**
 * Tests for deadline-aware bridge behavior in the `makaio hook handle` CLI bridge.
 *
 * Proves the six invariants required by the "Keep The Bridge Dumb And
 * Deadline-Aware" specification:
 *
 * 1. **Single stdin read** — stdin is read and parsed once; `hook.received` is
 *    emitted exactly once before the handle request.
 * 2. **Relative timeout only** — the bridge passes a relative timeout to the
 *    bus; it never mints or serializes an absolute deadline. The bus computes
 *    `RequestContext.deadline` internally.
 * 3. **Bus-owned deadline** — the bus exposes the absolute deadline via
 *    `RequestContext.deadline` to the terminal handler.
 * 4. **No-handler fast path** — when no handler is registered the bridge
 *    returns immediately without waiting for the timeout.
 * 5. **Fail-open by default** — missing bus and transport errors exit 0 unless
 *    `--fail-close` is explicitly set.
 * 6. **Verbatim stdout passthrough** — the bridge writes exactly one returned
 *    stdout document; it never parses, merges, or interprets the response.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { RawClientHookPayloadSchema, ClientHookHandleResponseSchema } from '@makaio/subsystem-client';
import { createBusNamespace, type SchemaRecord } from '@makaio/core';
import {
  runClientHookHandleCommand,
  type ClientHookHandleCommandContext,
  type ClientHookHandleCommandDependencies,
} from '../cli/client-hook-command.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Register a client hook namespace (received + handle) on the local test bus.
 * @param bus - Isolated bus instance under test.
 * @param clientId - Test-only client identifier.
 * @param additionalSchemas - Optional extra schemas owned by this namespace.
 * @returns Subjects registered on the local test bus.
 */
function registerTestClientNamespace<T extends SchemaRecord = Record<never, never>>(
  bus: IMakaioBus,
  clientId: string,
  additionalSchemas?: T,
) {
  return bus.registerNamespace(
    createBusNamespace(`client:${clientId}`, {
      'hook.received': RawClientHookPayloadSchema,
      'hook.handle': {
        request: RawClientHookPayloadSchema,
        response: ClientHookHandleResponseSchema,
      },
      ...((additionalSchemas ?? {}) as T),
    }),
  ).subjects;
}

/**
 * Build a minimal dependencies bundle for tests.
 * @param overrides - Partial overrides for specific dependency functions.
 */
function makeDeps(overrides: {
  readStdinText?: () => Promise<string>;
  writeStdout?: (text: string) => void;
  writeStderr?: (text: string) => void;
}): ClientHookHandleCommandDependencies {
  return {
    readStdinText: overrides.readStdinText ?? (async () => '{}'),
    writeStdout: overrides.writeStdout ?? vi.fn(),
    writeStderr: overrides.writeStderr ?? vi.fn(),
  };
}

// ===========================================================================
// 1. Single stdin read — emit hook.received exactly once before handle
// ===========================================================================

describe('deadline bridge — single stdin read', () => {
  it('reads stdin exactly once and emits hook.received exactly once', async () => {
    const readStdinText = vi.fn(async () => JSON.stringify({ tool: 'Bash' }));
    const order: string[] = [];
    const emit = vi.fn(async () => {
      order.push('received');
    });
    const requestOptional = vi.fn(async () => {
      order.push('handle');
      return { handled: false as const };
    });

    await runClientHookHandleCommand(
      {
        args: { client: 'stdin-once', eventName: 'PreToolUse', timeout: 5000, failClose: false },
        bus: { emit, requestOptional },
      },
      makeDeps({ readStdinText }),
    );

    expect(readStdinText).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledOnce();
    expect(order).toEqual(['received', 'handle']);
  });

  it('uses the same payload for hook.received and hook.handle', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'same-payload');

    const receivedPayloads: unknown[] = [];
    const handlePayloads: unknown[] = [];

    const receivedCleanup = bus.on(subjects.hook.received, ({ payload }) => {
      receivedPayloads.push(payload);
    });
    const handleCleanup = bus.on(subjects.hook.handle, (ctx) => {
      handlePayloads.push(ctx.payload);
      ctx.setResult({ exitCode: 0, stdout: '', stderr: '' });
    });

    await runClientHookHandleCommand(
      { args: { client: 'same-payload', eventName: 'PreToolUse', timeout: 5000, failClose: false }, bus },
      makeDeps({ readStdinText: async () => JSON.stringify({ tool_name: 'Read', input: '/etc' }) }),
    );

    receivedCleanup();
    handleCleanup();

    expect(receivedPayloads).toHaveLength(1);
    expect(handlePayloads).toHaveLength(1);
    expect(receivedPayloads[0]).toEqual(handlePayloads[0]);
  });
});

// ===========================================================================
// 2. Relative timeout only — bridge never mints an absolute deadline
// ===========================================================================

describe('deadline bridge — relative timeout passthrough', () => {
  it('passes a relative timeout (not an absolute deadline) to requestOptional', async () => {
    const emit = vi.fn(async () => {});
    let capturedOptions: { readonly timeout?: number } | undefined;
    const requestOptional: NonNullable<ClientHookHandleCommandContext['bus']>['requestOptional'] = async (
      _subject,
      _payload,
      options,
    ) => {
      capturedOptions = options;
      return { handled: false };
    };

    const before = Date.now();
    await runClientHookHandleCommand(
      {
        args: { client: 'timeout-relative', eventName: 'PreToolUse', timeout: 3000, failClose: false },
        bus: { emit, requestOptional },
      },
      makeDeps({}),
    );

    // The timeout passed to requestOptional must be a relative duration (<=3000ms),
    // not an absolute timestamp (which would be ~Date.now() + 3000, i.e. >1e12).
    expect(capturedOptions?.timeout).toBeDefined();
    expect(capturedOptions!.timeout).toBeGreaterThan(0);
    expect(capturedOptions!.timeout).toBeLessThanOrEqual(3000);
    // Absolute deadline would be > Date.now(), so ensure it is nowhere near that.
    expect(capturedOptions!.timeout).toBeLessThan(before);
  });

  it('deducts observation time from the remaining timeout budget', async () => {
    // Simulate an observation emit that takes ~50ms.
    const emit = vi.fn(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    let capturedTimeout: number | undefined;
    const requestOptional: NonNullable<ClientHookHandleCommandContext['bus']>['requestOptional'] = async (
      _subject,
      _payload,
      options,
    ) => {
      capturedTimeout = options?.timeout;
      return { handled: false };
    };

    await runClientHookHandleCommand(
      {
        args: { client: 'timeout-budget', eventName: 'PreToolUse', timeout: 5000, failClose: false },
        bus: { emit, requestOptional },
      },
      makeDeps({}),
    );

    // The remaining timeout should be less than the original 5000ms because the
    // observation step consumed part of the budget.
    expect(capturedTimeout).toBeDefined();
    expect(capturedTimeout).toBeLessThan(5000);
    expect(capturedTimeout).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 3. Bus-owned deadline — RequestContext.deadline is set by the bus
// ===========================================================================

describe('deadline bridge — bus-owned RequestContext.deadline', () => {
  it('exposes an absolute deadline on RequestContext from the relative timeout', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'deadline-ctx');

    let capturedDeadline: number | undefined;

    const cleanup = bus.on(subjects.hook.handle, (ctx) => {
      capturedDeadline = ctx.deadline;
      ctx.setResult({ exitCode: 0, stdout: 'ok', stderr: '' });
    });

    const before = Date.now();
    await runClientHookHandleCommand(
      { args: { client: 'deadline-ctx', eventName: 'PreToolUse', timeout: 5000, failClose: false }, bus },
      makeDeps({}),
    );
    const after = Date.now();

    cleanup();

    // The bus must mint an absolute deadline from the relative timeout.
    // It should be approximately Date.now() + remainingTimeout at the time of the
    // requestOptional call. The remaining timeout is <= 5000ms.
    expect(capturedDeadline).toBeDefined();
    expect(capturedDeadline).toBeGreaterThanOrEqual(before);
    // The deadline should be within a reasonable window: not more than 5s after 'after'.
    expect(capturedDeadline).toBeLessThanOrEqual(after + 5000);
  });
});

// ===========================================================================
// 4. No-handler fast path — immediate return when no handler is registered
// ===========================================================================

describe('deadline bridge — no-handler fast path', () => {
  it('returns immediately without waiting for timeout when no handler exists', async () => {
    const bus = createBusInstance();
    registerTestClientNamespace(bus, 'fast-path');

    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    const setExitCode = vi.fn();

    const start = Date.now();
    await runClientHookHandleCommand(
      {
        // Use a long timeout to prove we do NOT wait for it.
        args: { client: 'fast-path', eventName: 'PreToolUse', timeout: 30_000, failClose: false },
        bus,
      },
      makeDeps({ writeStdout, writeStderr }),
      setExitCode,
    );
    const elapsed = Date.now() - start;

    // Should complete in well under a second, not 30 seconds.
    expect(elapsed).toBeLessThan(2000);
    expect(writeStdout).not.toHaveBeenCalled();
    expect(writeStderr).not.toHaveBeenCalled();
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('exits 0 with no output on no-handler (fail-open)', async () => {
    const bus = createBusInstance();
    registerTestClientNamespace(bus, 'fast-path-open');

    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    const setExitCode = vi.fn();

    await runClientHookHandleCommand(
      { args: { client: 'fast-path-open', eventName: 'PostToolUse', timeout: 5000, failClose: false }, bus },
      makeDeps({ writeStdout, writeStderr }),
      setExitCode,
    );

    expect(writeStdout).not.toHaveBeenCalled();
    expect(writeStderr).not.toHaveBeenCalled();
    expect(setExitCode).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 5. Fail-open by default — missing bus and transport errors
// ===========================================================================

describe('deadline bridge — fail-open semantics', () => {
  it('exits 0 silently when bus is null (missing composer)', async () => {
    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    const setExitCode = vi.fn();

    await runClientHookHandleCommand(
      { args: { client: 'null-bus', eventName: 'PreToolUse', timeout: 5000, failClose: false }, bus: null },
      makeDeps({ writeStdout, writeStderr }),
      setExitCode,
    );

    expect(writeStdout).not.toHaveBeenCalled();
    expect(writeStderr).not.toHaveBeenCalled();
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('exits 0 silently when requestOptional rejects (transport failure)', async () => {
    const emit = vi.fn(async () => {});
    const requestOptional = vi.fn(async () => {
      throw new Error('transport connection refused');
    });
    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    const setExitCode = vi.fn();

    await runClientHookHandleCommand(
      {
        args: { client: 'transport-fail', eventName: 'PreToolUse', timeout: 5000, failClose: false },
        bus: { emit, requestOptional },
      },
      makeDeps({ writeStdout, writeStderr }),
      setExitCode,
    );

    expect(writeStdout).not.toHaveBeenCalled();
    expect(writeStderr).not.toHaveBeenCalled();
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('reports error to stderr and exits 1 when --fail-close is set and bus is null', async () => {
    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    const setExitCode = vi.fn();

    await runClientHookHandleCommand(
      { args: { client: 'fail-close-null', eventName: 'PreToolUse', timeout: 5000, failClose: true }, bus: null },
      makeDeps({ writeStdout, writeStderr }),
      setExitCode,
    );

    expect(writeStdout).not.toHaveBeenCalled();
    expect(writeStderr).toHaveBeenCalledOnce();
    expect(writeStderr.mock.calls[0]?.[0]).toContain('bus is unavailable');
    expect(setExitCode).toHaveBeenCalledWith(1);
  });

  it('reports error to stderr and exits 1 when --fail-close is set and transport fails', async () => {
    const emit = vi.fn(async () => {});
    const requestOptional = vi.fn(async () => {
      throw new Error('connection reset');
    });
    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    const setExitCode = vi.fn();

    await runClientHookHandleCommand(
      {
        args: { client: 'fail-close-transport', eventName: 'PreToolUse', timeout: 100, failClose: true },
        bus: { emit, requestOptional },
      },
      makeDeps({ writeStdout, writeStderr }),
      setExitCode,
    );

    expect(writeStdout).not.toHaveBeenCalled();
    expect(writeStderr).toHaveBeenCalledOnce();
    expect(writeStderr.mock.calls[0]?.[0]).toContain('connection reset');
    expect(setExitCode).toHaveBeenCalledWith(1);
  });
});

// ===========================================================================
// 6. Verbatim stdout passthrough — bridge never parses response content
// ===========================================================================

describe('deadline bridge — verbatim stdout passthrough', () => {
  it('writes handler stdout verbatim without parsing or transformation', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'passthrough-stdout');

    // Return a JSON-like string as stdout — the bridge must NOT parse it.
    const rawOutput = '{"decision":"block","reason":"forbidden tool"}\n';
    const cleanup = bus.on(subjects.hook.handle, (ctx) => {
      ctx.setResult({ exitCode: 0, stdout: rawOutput, stderr: '' });
    });

    const writeStdout = vi.fn();
    const writeStderr = vi.fn();

    await runClientHookHandleCommand(
      { args: { client: 'passthrough-stdout', eventName: 'PreToolUse', timeout: 5000, failClose: false }, bus },
      makeDeps({ writeStdout, writeStderr }),
    );

    cleanup();

    expect(writeStdout).toHaveBeenCalledOnce();
    expect(writeStdout).toHaveBeenCalledWith(rawOutput);
    expect(writeStderr).not.toHaveBeenCalled();
  });

  it('writes handler stderr verbatim without parsing or transformation', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'passthrough-stderr');

    const rawErr = 'WARN: tool blocked by policy\n';
    const cleanup = bus.on(subjects.hook.handle, (ctx) => {
      ctx.setResult({ exitCode: 1, stdout: '', stderr: rawErr });
    });

    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    const setExitCode = vi.fn();

    await runClientHookHandleCommand(
      { args: { client: 'passthrough-stderr', eventName: 'PreToolUse', timeout: 5000, failClose: false }, bus },
      makeDeps({ writeStdout, writeStderr }),
      setExitCode,
    );

    cleanup();

    expect(writeStdout).not.toHaveBeenCalled();
    expect(writeStderr).toHaveBeenCalledOnce();
    expect(writeStderr).toHaveBeenCalledWith(rawErr);
    expect(setExitCode).toHaveBeenCalledWith(1);
  });

  it('passes exit code through without interpretation', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'passthrough-exit');

    const cleanup = bus.on(subjects.hook.handle, (ctx) => {
      ctx.setResult({ exitCode: 42, stdout: '', stderr: '' });
    });

    const setExitCode = vi.fn();

    await runClientHookHandleCommand(
      { args: { client: 'passthrough-exit', eventName: 'PreToolUse', timeout: 5000, failClose: false }, bus },
      makeDeps({}),
      setExitCode,
    );

    cleanup();

    expect(setExitCode).toHaveBeenCalledWith(42);
  });

  it('does not merge multiple response fields into stdout', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'no-merge');

    const cleanup = bus.on(subjects.hook.handle, (ctx) => {
      ctx.setResult({ exitCode: 0, stdout: 'out-only', stderr: 'err-only' });
    });

    const writeStdout = vi.fn();
    const writeStderr = vi.fn();

    await runClientHookHandleCommand(
      { args: { client: 'no-merge', eventName: 'PreToolUse', timeout: 5000, failClose: false }, bus },
      makeDeps({ writeStdout, writeStderr }),
    );

    cleanup();

    // Each channel receives exactly its own content — nothing merged.
    expect(writeStdout).toHaveBeenCalledOnce();
    expect(writeStdout).toHaveBeenCalledWith('out-only');
    expect(writeStderr).toHaveBeenCalledOnce();
    expect(writeStderr).toHaveBeenCalledWith('err-only');
  });
});
