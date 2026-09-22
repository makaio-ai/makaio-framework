/**
 * Tests for supervisor-provided identity propagation through both client-hook
 * command paths.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runClientHookCommand,
  runClientHookHandleCommand,
  type ClientHookHandleCommandDependencies,
} from '../cli/client-hook-command.js';

const SUPERVISOR_SESSION_ID_ENV = 'MAKAIO_SUPERVISOR_SESSION_ID';
const unrelatedEnvironmentKey = 'MAKAIO_UNRELATED_TEST_CONTEXT';

const originalSupervisorSessionId = process.env[SUPERVISOR_SESSION_ID_ENV];
const originalUnrelatedEnvironmentValue = process.env[unrelatedEnvironmentKey];

type HookPayload = { metadata?: Record<string, unknown> };

afterEach(() => {
  if (originalSupervisorSessionId === undefined) {
    delete process.env[SUPERVISOR_SESSION_ID_ENV];
  } else {
    process.env[SUPERVISOR_SESSION_ID_ENV] = originalSupervisorSessionId;
  }

  if (originalUnrelatedEnvironmentValue === undefined) {
    delete process.env[unrelatedEnvironmentKey];
  } else {
    process.env[unrelatedEnvironmentKey] = originalUnrelatedEnvironmentValue;
  }
});

function makeHandleDependencies(): ClientHookHandleCommandDependencies {
  return {
    readStdinText: async () => '{}',
    writeStdout: vi.fn(),
    writeStderr: vi.fn(),
  };
}

function createCapturingBus() {
  const emittedPayloads: HookPayload[] = [];
  const requestedPayloads: HookPayload[] = [];
  const emit = vi.fn(async (...args: unknown[]) => {
    emittedPayloads.push(args[1] as HookPayload);
  });
  const requestOptional = vi.fn(async (...args: unknown[]) => {
    requestedPayloads.push(args[1] as HookPayload);
    return { handled: false as const };
  });

  return { bus: { emit, requestOptional }, emittedPayloads, requestedPayloads, requestOptional };
}

function capturedPayload(payloads: HookPayload[], index = 0): HookPayload {
  const payload = payloads[index];
  if (payload === undefined) {
    throw new Error('Expected the hook command to dispatch a payload.');
  }
  return payload;
}

describe('client hook command supervisor identity', () => {
  it('adds only the allowlisted supervisor identity to received metadata and gives it precedence', async () => {
    process.env[SUPERVISOR_SESSION_ID_ENV] = 'supervisor-session-123';
    process.env[unrelatedEnvironmentKey] = 'must-not-be-forwarded';

    const { bus, emittedPayloads, requestedPayloads } = createCapturingBus();

    await runClientHookCommand(
      {
        args: {
          client: 'codex',
          eventName: 'session_started',
          metadataJson: JSON.stringify({ supplied: 'metadata', supervisorSessionId: 'caller-value' }),
        },
        bus,
      },
      { readStdinText: async () => '{}' },
    );

    const emittedPayload = capturedPayload(emittedPayloads);
    expect(emittedPayload.metadata).toEqual({
      supplied: 'metadata',
      supervisorSessionId: 'supervisor-session-123',
    });
    expect(emittedPayload.metadata).not.toHaveProperty(unrelatedEnvironmentKey);

    const observedPayload = capturedPayload(requestedPayloads);
    expect(observedPayload.metadata).toEqual(emittedPayload.metadata);
  });

  it('adds only the allowlisted supervisor identity to handle metadata and gives it precedence', async () => {
    process.env[SUPERVISOR_SESSION_ID_ENV] = 'supervisor-session-456';
    process.env[unrelatedEnvironmentKey] = 'must-not-be-forwarded';

    const { bus, emittedPayloads, requestedPayloads } = createCapturingBus();

    await runClientHookHandleCommand(
      {
        args: {
          client: 'claude-code',
          eventName: 'PreToolUse',
          metadataJson: JSON.stringify({ supplied: 'metadata', supervisorSessionId: 'caller-value' }),
          timeout: 5_000,
          failClose: false,
        },
        bus,
      },
      makeHandleDependencies(),
    );

    const emittedPayload = capturedPayload(emittedPayloads);
    const handledPayload = capturedPayload(requestedPayloads, 1);
    expect(emittedPayload.metadata).toEqual({
      supplied: 'metadata',
      supervisorSessionId: 'supervisor-session-456',
    });
    expect(handledPayload.metadata).toEqual(emittedPayload.metadata);
    expect(handledPayload.metadata).not.toHaveProperty(unrelatedEnvironmentKey);
  });

  it('preserves supplied metadata when the supervisor identity is absent', async () => {
    delete process.env[SUPERVISOR_SESSION_ID_ENV];

    const { bus, emittedPayloads } = createCapturingBus();

    await runClientHookCommand(
      {
        args: {
          client: 'codex',
          eventName: 'session_started',
          metadataJson: JSON.stringify({ supplied: 'metadata', supervisorSessionId: 'caller-value' }),
        },
        bus,
      },
      { readStdinText: async () => '{}' },
    );

    const emittedPayload = capturedPayload(emittedPayloads);
    expect(emittedPayload.metadata).toEqual({ supplied: 'metadata', supervisorSessionId: 'caller-value' });
  });

  it('does not synthesize metadata on either command path when no identity is available', async () => {
    delete process.env[SUPERVISOR_SESSION_ID_ENV];

    const received = createCapturingBus();
    await runClientHookCommand(
      {
        args: { client: 'codex', eventName: 'session_started' },
        bus: received.bus,
      },
      { readStdinText: async () => '{}' },
    );

    const handle = createCapturingBus();
    await runClientHookHandleCommand(
      {
        args: { client: 'claude-code', eventName: 'PreToolUse', timeout: 5_000, failClose: false },
        bus: handle.bus,
      },
      makeHandleDependencies(),
    );

    expect(capturedPayload(received.emittedPayloads)).not.toHaveProperty('metadata');
    expect(capturedPayload(handle.emittedPayloads)).not.toHaveProperty('metadata');
    expect(received.requestOptional).not.toHaveBeenCalled();
    expect(handle.requestOptional).toHaveBeenCalledOnce();
  });
});
