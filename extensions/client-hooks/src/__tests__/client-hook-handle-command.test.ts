/**
 * Tests for the `makaio hook handle` CLI bridge.
 *
 * Exercises {@link runClientHookHandleCommand} against a real
 * `createBusInstance()` to verify the full path without relying on the process
 * singleton.  Injectable dependencies keep stdin I/O and process stream writes
 * out of the test process entirely.
 *
 * Contract coverage:
 * - Emits `hook.received` before issuing the handle request (observation invariant).
 * - Writes handler-supplied stdout/stderr and propagates exit code.
 * - Exits 0 with no output when no handler is registered (`handled: false`).
 * - Fail-open: errors write nothing and exit 0 unless `--fail-close` is set.
 * - Fail-close: errors write to stderr and exit 1.
 * - Forwards stdin payload and metadata verbatim.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import {
  RawClientHookPayloadSchema,
  ClientHookHandleResponseSchema,
  createRawClientHookReceivedSubject,
} from '@makaio/subsystem-client';
import { createBusNamespace, type SchemaRecord } from '@makaio/core';
import type { CommandContext, OutputWriter } from '@makaio/kernel/cli';
import {
  handleClientHookHandle,
  runClientHookHandleCommand,
  type ClientHookHandleArgs,
  type ClientHookHandleCommandContext,
} from '../cli/client-hook-command.js';
import { clientHooksCli } from '../cli/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Test bus helpers
// ---------------------------------------------------------------------------

/**
 * Register a client hook namespace (received + handle) on the local test bus.
 *
 * The CLI bridge emits through non-owning subjects, so tests that use an
 * isolated bus must register the concrete schemas on that same bus instance.
 * @param bus - Isolated bus instance under test.
 * @param clientId - Test-only client identifier.
 * @param additionalSchemas - Optional extra schemas owned by this namespace.
 * @returns Subjects registered on the local test bus.
 */
function registerTestClientNamespace<AdditionalSchemas extends SchemaRecord = Record<never, never>>(
  bus: IMakaioBus,
  clientId: string,
  additionalSchemas?: AdditionalSchemas,
) {
  return bus.registerNamespace(
    createBusNamespace(`client:${clientId}`, {
      'hook.received': RawClientHookPayloadSchema,
      'hook.handle': {
        request: RawClientHookPayloadSchema,
        response: ClientHookHandleResponseSchema,
      },
      ...((additionalSchemas ?? {}) as AdditionalSchemas),
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
}) {
  return {
    readStdinText: overrides.readStdinText ?? (async () => '{}'),
    writeStdout: overrides.writeStdout ?? vi.fn(),
    writeStderr: overrides.writeStderr ?? vi.fn(),
  };
}

/**
 * Create an output writer that records stdout/stderr chunks separately.
 * @returns Output writer plus captured output arrays.
 */
function createCapturedOutput(): OutputWriter & { readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    write(text) {
      stdout.push(text);
    },
    error(text) {
      stderr.push(text);
    },
  };
}

// ---------------------------------------------------------------------------
// CLI handler output capture
// ---------------------------------------------------------------------------

describe('handleClientHookHandle — CLI output capture', () => {
  it('routes handler stdout and stderr through ctx.output without touching process streams', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'cli-output');
    const cleanup = bus.on(subjects.hook.handle, (ctx) => {
      ctx.setResult({ exitCode: 0, stdout: 'captured stdout\n', stderr: 'captured stderr\n' });
    });
    vi.spyOn(bus, 'emit').mockResolvedValue(undefined);
    const output = createCapturedOutput();
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const originalIsTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    try {
      await handleClientHookHandle({
        args: { client: 'cli-output', eventName: 'PreToolUse', timeout: 5000, failClose: false },
        bus,
        output,
        signal: new AbortController().signal,
        setExitCode: vi.fn(),
      } satisfies CommandContext<ClientHookHandleArgs>);
    } finally {
      if (originalIsTty) {
        Object.defineProperty(process.stdin, 'isTTY', originalIsTty);
      } else {
        delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
      cleanup();
    }

    expect(output.stdout).toEqual(['captured stdout\n']);
    expect(output.stderr).toEqual(['captured stderr\n']);
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Observation invariant: hook.received always emitted before handle request
// ---------------------------------------------------------------------------

describe('runClientHookHandleCommand — observation invariant', () => {
  it('emits hook.received even when handle returns handled: false', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'obs-invariant-1');

    const received: unknown[] = [];
    const cleanup = bus.on(subjects.hook.received, ({ payload }) => {
      received.push(payload);
    });

    await runClientHookHandleCommand(
      { args: { client: 'obs-invariant-1', eventName: 'PreToolUse', timeout: 5000, failClose: false }, bus },
      makeDeps({}),
    );

    cleanup();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ eventName: 'PreToolUse' });
  });

  it('emits hook.received before requesting a handle response', async () => {
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
        args: { client: 'obs-invariant-2', eventName: 'PostToolUse', timeout: 5000, failClose: false },
        bus: { emit, requestOptional },
      },
      makeDeps({}),
    );

    expect(order).toEqual(['received', 'handle']);
    expect(emit.mock.invocationCallOrder[0]).toBeLessThan(requestOptional.mock.invocationCallOrder[0]);
  });

  it('still emits hook.received when the handle bus call throws', async () => {
    const emit = vi.fn(async () => {});
    const requestOptional = vi.fn(async () => {
      throw new Error('bus-level failure');
    });

    await runClientHookHandleCommand(
      {
        args: { client: 'obs-invariant-3', eventName: 'Stop', timeout: 5000, failClose: false },
        bus: { emit, requestOptional },
      },
      makeDeps({}),
    );

    // emit was called exactly once (for hook.received) before requestOptional threw.
    // Verify the subject passed matches the expected namespaced hook.received subject definition.
    const expectedSubject = createRawClientHookReceivedSubject('obs-invariant-3');
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(expectedSubject, expect.objectContaining({ eventName: 'Stop' }));
  });

  it('still issues the handle request when hook.received emit fails', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'obs-invariant-4');
    const cleanup = bus.on(subjects.hook.handle, (ctx) => {
      ctx.setResult({ exitCode: 0, stdout: 'handled after emit failure', stderr: '' });
    });
    const emit = vi.spyOn(bus, 'emit').mockRejectedValue(new Error('emit failed'));
    const requestOptional = vi.spyOn(bus, 'requestOptional');
    const writeStdout = vi.fn();

    try {
      await runClientHookHandleCommand(
        {
          args: { client: 'obs-invariant-4', eventName: 'Stop', timeout: 5000, failClose: false },
          bus,
        },
        makeDeps({ writeStdout }),
      );
    } finally {
      cleanup();
    }

    expect(emit).toHaveBeenCalledOnce();
    expect(requestOptional).toHaveBeenCalledOnce();
    expect(writeStdout).toHaveBeenCalledWith('handled after emit failure');
  });

  it('does not exceed the handle timeout waiting for a stalled hook.received emit', async () => {
    const emit = vi.fn(() => new Promise<void>(() => {}));
    const requestOptional = vi.fn(async () => ({ handled: false as const }));
    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    const setExitCode = vi.fn();

    await runClientHookHandleCommand(
      {
        args: { client: 'obs-timeout', eventName: 'PreToolUse', timeout: 1, failClose: false },
        bus: { emit, requestOptional },
      },
      makeDeps({ writeStdout, writeStderr }),
      setExitCode,
    );

    expect(emit).toHaveBeenCalledOnce();
    expect(requestOptional).not.toHaveBeenCalled();
    expect(writeStdout).not.toHaveBeenCalled();
    expect(writeStderr).not.toHaveBeenCalled();
    expect(setExitCode).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handled: true — response forwarding
// ---------------------------------------------------------------------------

describe('runClientHookHandleCommand — handled: true response forwarding', () => {
  it('writes handler stdout to the stdout channel', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'resp-stdout');

    const cleanup = bus.on(subjects.hook.handle, (ctx) => {
      ctx.setResult({ exitCode: 0, stdout: 'hello output\n', stderr: '' });
    });

    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    await runClientHookHandleCommand(
      { args: { client: 'resp-stdout', eventName: 'PreToolUse', timeout: 5000, failClose: false }, bus },
      makeDeps({ writeStdout, writeStderr }),
    );

    cleanup();

    expect(writeStdout).toHaveBeenCalledWith('hello output\n');
    expect(writeStderr).not.toHaveBeenCalled();
  });

  it('writes handler stderr to the stderr channel', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'resp-stderr');

    const cleanup = bus.on(subjects.hook.handle, (ctx) => {
      ctx.setResult({ exitCode: 0, stdout: '', stderr: 'warning message\n' });
    });

    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    await runClientHookHandleCommand(
      { args: { client: 'resp-stderr', eventName: 'PreToolUse', timeout: 5000, failClose: false }, bus },
      makeDeps({ writeStdout, writeStderr }),
    );

    cleanup();

    expect(writeStdout).not.toHaveBeenCalled();
    expect(writeStderr).toHaveBeenCalledWith('warning message\n');
  });

  it('sets non-zero exit code from handler response', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'resp-exitcode');

    const cleanup = bus.on(subjects.hook.handle, (ctx) => {
      ctx.setResult({ exitCode: 2, stdout: '', stderr: '' });
    });

    const setExitCode = vi.fn();
    await runClientHookHandleCommand(
      { args: { client: 'resp-exitcode', eventName: 'PreToolUse', timeout: 5000, failClose: false }, bus },
      makeDeps({}),
      setExitCode,
    );

    cleanup();

    expect(setExitCode).toHaveBeenCalledWith(2);
  });

  it('does not call setExitCode when handler returns exitCode 0', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'resp-exitcode-zero');

    const cleanup = bus.on(subjects.hook.handle, (ctx) => {
      ctx.setResult({ exitCode: 0, stdout: 'ok', stderr: '' });
    });

    const setExitCode = vi.fn();
    await runClientHookHandleCommand(
      { args: { client: 'resp-exitcode-zero', eventName: 'Stop', timeout: 5000, failClose: false }, bus },
      makeDeps({}),
      setExitCode,
    );

    cleanup();

    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('forwards both stdout and stderr when both are non-empty', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'resp-both');

    const cleanup = bus.on(subjects.hook.handle, (ctx) => {
      ctx.setResult({ exitCode: 1, stdout: 'out text', stderr: 'err text' });
    });

    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    const setExitCode = vi.fn();
    await runClientHookHandleCommand(
      { args: { client: 'resp-both', eventName: 'Stop', timeout: 5000, failClose: false }, bus },
      makeDeps({ writeStdout, writeStderr }),
      setExitCode,
    );

    cleanup();

    expect(writeStdout).toHaveBeenCalledWith('out text');
    expect(writeStderr).toHaveBeenCalledWith('err text');
    expect(setExitCode).toHaveBeenCalledWith(1);
  });

  it('applies response defaults when a handler returns a partial response', async () => {
    const bus = createBusInstance();
    const subjects = bus.registerNamespace(
      createBusNamespace('client:resp-defaults', {
        'hook.received': RawClientHookPayloadSchema,
        'hook.handle': {
          request: RawClientHookPayloadSchema,
          response: ClientHookHandleResponseSchema.partial(),
        },
      }),
    ).subjects;

    const cleanup = bus.on(subjects.hook.handle, (ctx) => {
      ctx.setResult({ stdout: 'ok' });
    });

    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    const setExitCode = vi.fn();
    await runClientHookHandleCommand(
      { args: { client: 'resp-defaults', eventName: 'PreToolUse', timeout: 5000, failClose: false }, bus },
      makeDeps({ writeStdout, writeStderr }),
      setExitCode,
    );

    cleanup();

    expect(writeStdout).toHaveBeenCalledWith('ok');
    expect(writeStderr).not.toHaveBeenCalled();
    expect(setExitCode).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handled: false — no handler registered
// ---------------------------------------------------------------------------

describe('runClientHookHandleCommand — handled: false', () => {
  it('exits 0 with no output when no handler is registered', async () => {
    const bus = createBusInstance();
    registerTestClientNamespace(bus, 'no-handler');

    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    const setExitCode = vi.fn();

    await runClientHookHandleCommand(
      { args: { client: 'no-handler', eventName: 'PreToolUse', timeout: 5000, failClose: false }, bus },
      makeDeps({ writeStdout, writeStderr }),
      setExitCode,
    );

    expect(writeStdout).not.toHaveBeenCalled();
    expect(writeStderr).not.toHaveBeenCalled();
    expect(setExitCode).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Fail-open behaviour (--fail-close: false, the default)
// ---------------------------------------------------------------------------

describe('runClientHookHandleCommand — fail-open (default)', () => {
  it('keeps real bus timeouts silent', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'real-timeout');
    const cleanup = bus.on(subjects.hook.handle, () => new Promise<void>(() => {}));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    const setExitCode = vi.fn();

    await runClientHookHandleCommand(
      {
        args: { client: 'real-timeout', eventName: 'PreToolUse', timeout: 1, failClose: false },
        bus,
      },
      makeDeps({ writeStdout, writeStderr }),
      setExitCode,
    );

    cleanup();

    expect(consoleError).not.toHaveBeenCalled();
    expect(writeStdout).not.toHaveBeenCalled();
    expect(writeStderr).not.toHaveBeenCalled();
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('resolves without output or non-zero exit when requestOptional throws', async () => {
    const emit = vi.fn(async () => {});
    const requestOptional = vi.fn(async () => {
      throw new Error('timeout');
    });

    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    const setExitCode = vi.fn();

    await expect(
      runClientHookHandleCommand(
        {
          args: { client: 'fail-open', eventName: 'Stop', timeout: 100, failClose: false },
          bus: { emit, requestOptional },
        },
        makeDeps({ writeStdout, writeStderr }),
        setExitCode,
      ),
    ).resolves.toBeUndefined();

    expect(writeStdout).not.toHaveBeenCalled();
    expect(writeStderr).not.toHaveBeenCalled();
    expect(setExitCode).not.toHaveBeenCalled();
  });

  it('resolves silently when bus is null', async () => {
    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    const setExitCode = vi.fn();

    await expect(
      runClientHookHandleCommand(
        {
          args: { client: 'null-bus', eventName: 'Stop', timeout: 5000, failClose: false },
          bus: null,
        },
        makeDeps({ writeStdout, writeStderr }),
        setExitCode,
      ),
    ).resolves.toBeUndefined();

    expect(writeStdout).not.toHaveBeenCalled();
    expect(writeStderr).not.toHaveBeenCalled();
    expect(setExitCode).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Fail-close behaviour (--fail-close: true)
// ---------------------------------------------------------------------------

describe('runClientHookHandleCommand — fail-close', () => {
  it('writes error message to stderr and sets exit 1 on error', async () => {
    const emit = vi.fn(async () => {});
    const requestOptional = vi.fn(async () => {
      throw new Error('request timed out');
    });

    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    const setExitCode = vi.fn();

    await runClientHookHandleCommand(
      {
        args: { client: 'fail-close', eventName: 'PreToolUse', timeout: 100, failClose: true },
        bus: { emit, requestOptional },
      },
      makeDeps({ writeStdout, writeStderr }),
      setExitCode,
    );

    expect(writeStderr).toHaveBeenCalledOnce();
    expect(writeStderr.mock.calls[0]?.[0]).toContain('request timed out');
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(writeStdout).not.toHaveBeenCalled();
  });

  it('writes stringified error to stderr when thrown value is not an Error', async () => {
    const emit = vi.fn(async () => {});
    const requestOptional = vi.fn(async () => {
      throw 'string-error';
    });

    const writeStderr = vi.fn();

    await runClientHookHandleCommand(
      {
        args: { client: 'fail-close-str', eventName: 'Stop', timeout: 100, failClose: true },
        bus: { emit, requestOptional },
      },
      makeDeps({ writeStderr }),
    );

    expect(writeStderr).toHaveBeenCalledOnce();
    expect(writeStderr.mock.calls[0]?.[0]).toContain('string-error');
  });

  it('writes an error and sets exit 1 when bus is unavailable', async () => {
    const writeStdout = vi.fn();
    const writeStderr = vi.fn();
    const setExitCode = vi.fn();

    await runClientHookHandleCommand(
      {
        args: { client: 'fail-close-null-bus', eventName: 'Stop', timeout: 5000, failClose: true },
        bus: null,
      },
      makeDeps({ writeStdout, writeStderr }),
      setExitCode,
    );

    expect(writeStdout).not.toHaveBeenCalled();
    expect(writeStderr).toHaveBeenCalledWith('[hook handle] error: Makaio bus is unavailable.\n');
    expect(setExitCode).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// Timeout option forwarding
// ---------------------------------------------------------------------------

describe('runClientHookHandleCommand — timeout forwarding', () => {
  it('passes the timeout option to requestOptional', async () => {
    const emit = vi.fn(async () => {});
    let requestOptions: { readonly timeout?: number } | undefined;
    const requestOptional: NonNullable<ClientHookHandleCommandContext['bus']>['requestOptional'] = async (
      _subject,
      _payload,
      options,
    ) => {
      requestOptions = options;
      return { handled: false };
    };

    await runClientHookHandleCommand(
      {
        args: { client: 'timeout-check', eventName: 'Stop', timeout: 1234, failClose: false },
        bus: { emit, requestOptional },
      },
      makeDeps({}),
    );

    expect(requestOptions?.timeout).toBeGreaterThan(0);
    expect(requestOptions?.timeout).toBeLessThanOrEqual(1234);
  });
});

// ---------------------------------------------------------------------------
// CLI contribution defaults
// ---------------------------------------------------------------------------

describe('clientHooksCli — handle schema defaults', () => {
  it('defaults timeout to 5000 and failClose to false', () => {
    const handleSubcommand = clientHooksCli.subcommands.find((subcommand) => subcommand.name === 'handle');

    expect(handleSubcommand).toBeDefined();
    const parsed = handleSubcommand!.schema.parse({
      client: 'claude-code',
      eventName: 'PreToolUse',
    });

    expect(parsed).toMatchObject({
      client: 'claude-code',
      eventName: 'PreToolUse',
      timeout: 5000,
      failClose: false,
    });
  });

  it('rejects timeout 0 because bus timeouts must be bounded', () => {
    const handleSubcommand = clientHooksCli.subcommands.find((subcommand) => subcommand.name === 'handle');

    expect(handleSubcommand).toBeDefined();
    expect(
      handleSubcommand?.schema.safeParse({
        client: 'codex',
        eventName: 'PreToolUse',
        timeout: 0,
        failClose: false,
      }).success,
    ).toBe(false);
  });

  it('declares the handle subcommand in descriptor.json', async () => {
    const descriptor = JSON.parse(await readFile(new URL('../../descriptor.json', import.meta.url), 'utf-8')) as {
      cli?: { subcommands?: Array<{ name?: string; args?: Array<{ name?: string }> }> };
    };
    const handleSubcommand = descriptor.cli?.subcommands?.find((subcommand) => subcommand.name === 'handle');

    expect(handleSubcommand).toBeDefined();
    expect(handleSubcommand?.args?.map((arg) => arg.name)).toEqual([
      'client',
      'eventName',
      'metadataJson',
      'timeout',
      'failClose',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Stdin payload forwarding
// ---------------------------------------------------------------------------

describe('runClientHookHandleCommand — stdin payload forwarding', () => {
  it('forwards stdin JSON as payload in the hook.handle request', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'payload-fwd');

    const requests: unknown[] = [];
    const cleanup = bus.on(subjects.hook.handle, (ctx) => {
      requests.push(ctx.payload);
      ctx.setResult({ exitCode: 0, stdout: '', stderr: '' });
    });

    await runClientHookHandleCommand(
      { args: { client: 'payload-fwd', eventName: 'PreToolUse', timeout: 5000, failClose: false }, bus },
      makeDeps({ readStdinText: async () => JSON.stringify({ tool_name: 'Bash', input: 'ls' }) }),
    );

    cleanup();

    expect(requests[0]).toMatchObject({ payload: { tool_name: 'Bash', input: 'ls' } });
  });

  it('attaches parsed metadata to the handle request payload', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'meta-handle');

    const requests: unknown[] = [];
    const cleanup = bus.on(subjects.hook.handle, (ctx) => {
      requests.push(ctx.payload);
      ctx.setResult({ exitCode: 0, stdout: '', stderr: '' });
    });

    await runClientHookHandleCommand(
      {
        args: {
          client: 'meta-handle',
          eventName: 'PreToolUse',
          metadataJson: '{"pid":5678}',
          timeout: 5000,
          failClose: false,
        },
        bus,
      },
      makeDeps({}),
    );

    cleanup();

    expect(requests[0]).toMatchObject({ metadata: { pid: 5678 } });
  });
});
