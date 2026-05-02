/**
 * Tests for the generic client hook CLI bridge.
 *
 * The bridge is exercised against a real `createBusInstance()` so tests verify
 * the full emit path without relying on the process singleton.  The injectable
 * `readStdinText` dependency keeps stdin I/O out of the test process entirely.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { RawClientHookPayloadSchema } from '@makaio/clients-core';
import type { SchemaRecord } from '@makaio/core';
import { runClientHookCommand } from '../cli/client-hook-command.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Register a client hook namespace on the local test bus.
 *
 * The CLI bridge emits through a non-owning subject, so tests that use an
 * isolated bus must register the concrete schema on that same bus instance.
 * Registering through `createClientNamespace()` would mutate the process
 * singleton instead and leave the local bus without validation coverage.
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
  return bus.registerNamespace(`client:${clientId}`, {
    'hook.received': RawClientHookPayloadSchema,
    ...((additionalSchemas ?? {}) as AdditionalSchemas),
  }).subjects;
}

// ---------------------------------------------------------------------------
// Core contract: emits the raw catch-all subject
// ---------------------------------------------------------------------------

describe('runClientHookCommand — raw catch-all subject', () => {
  it('emits hook.received on the client-specific namespace subject', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'test-hook');

    const received: unknown[] = [];
    const cleanup = bus.on(subjects.hook.received, ({ payload }) => {
      received.push(payload);
    });

    await runClientHookCommand(
      { args: { client: 'test-hook', eventName: 'session_started' }, bus },
      { readStdinText: async () => '{}' },
    );

    cleanup();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ eventName: 'session_started' });
  });

  it('emits with eventName passed through verbatim', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'test-hook-2');

    const received: Array<{ eventName: string }> = [];
    const cleanup = bus.on(subjects.hook.received, ({ payload }) => {
      received.push(payload as { eventName: string });
    });

    await runClientHookCommand(
      { args: { client: 'test-hook-2', eventName: 'PreToolUse' }, bus },
      { readStdinText: async () => '{}' },
    );

    cleanup();

    expect(received[0]?.eventName).toBe('PreToolUse');
  });

  it('emits a numeric receivedAt timestamp', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'ts-check');

    const received: unknown[] = [];
    const cleanup = bus.on(subjects.hook.received, ({ payload }) => {
      received.push(payload);
    });

    const before = Date.now();
    await runClientHookCommand(
      { args: { client: 'ts-check', eventName: 'Stop' }, bus },
      { readStdinText: async () => '{}' },
    );
    const after = Date.now();

    cleanup();

    const evt = received[0] as { receivedAt: number };
    expect(evt.receivedAt).toBeGreaterThanOrEqual(before);
    expect(evt.receivedAt).toBeLessThanOrEqual(after);
  });

  it('does not re-register or narrow concrete client namespaces owned elsewhere', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'owner-with-extra', {
      'statusline.received': z.object({ status: z.string() }),
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const received: unknown[] = [];
    const cleanup = bus.on(subjects.hook.received, ({ payload }) => {
      received.push(payload);
    });

    await runClientHookCommand(
      { args: { client: 'owner-with-extra', eventName: 'Stop' }, bus },
      { readStdinText: async () => '{}' },
    );

    cleanup();

    expect(received).toHaveLength(1);
    expect(subjects.statusline.received.subject).toBe('statusline.received');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('waits for async bus emission before resolving', async () => {
    let resolveEmit!: () => void;
    const emit = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveEmit = resolve;
        }),
    );
    const requestOptional = vi.fn(async () => ({ handled: false as const }));

    const commandPromise = runClientHookCommand(
      {
        args: { client: 'await-emission', eventName: 'Stop' },
        bus: { emit, requestOptional },
      },
      { readStdinText: async () => '{}' },
    );

    let settled = false;
    void commandPromise.then(() => {
      settled = true;
    });
    for (let i = 0; i < 5 && emit.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }

    expect(emit).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    resolveEmit();
    await expect(commandPromise).resolves.toBeUndefined();
    expect(settled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Core contract: reads JSON from stdin
// ---------------------------------------------------------------------------

describe('runClientHookCommand — stdin JSON', () => {
  it('forwards the stdin JSON object as the payload field', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'codex');

    const received: unknown[] = [];
    const cleanup = bus.on(subjects.hook.received, ({ payload }) => {
      received.push(payload);
    });

    await runClientHookCommand(
      { args: { client: 'codex', eventName: 'session_started' }, bus },
      { readStdinText: async () => JSON.stringify({ session_id: 'sess-1', pid: 42 }) },
    );

    cleanup();

    expect(received[0]).toMatchObject({
      payload: { session_id: 'sess-1', pid: 42 },
    });
  });

  it('uses an empty object payload when stdin contains only whitespace', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'codex-ws');

    const received: unknown[] = [];
    const cleanup = bus.on(subjects.hook.received, ({ payload }) => {
      received.push(payload);
    });

    await runClientHookCommand(
      { args: { client: 'codex-ws', eventName: 'Stop' }, bus },
      { readStdinText: async () => '   \n' },
    );

    cleanup();

    expect(received[0]).toMatchObject({ payload: {} });
  });

  it('uses an empty object payload when stdin is empty', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'codex-empty');

    const received: unknown[] = [];
    const cleanup = bus.on(subjects.hook.received, ({ payload }) => {
      received.push(payload);
    });

    await runClientHookCommand(
      { args: { client: 'codex-empty', eventName: 'Stop' }, bus },
      { readStdinText: async () => '' },
    );

    cleanup();

    expect(received[0]).toMatchObject({ payload: {} });
  });
});

// ---------------------------------------------------------------------------
// Core contract: fail-open behaviour
// ---------------------------------------------------------------------------

describe('runClientHookCommand — fail-open', () => {
  it('still emits when stdin read throws', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'fail-open-read');

    const received: unknown[] = [];
    const cleanup = bus.on(subjects.hook.received, ({ payload }) => {
      received.push(payload);
    });

    await expect(
      runClientHookCommand(
        { args: { client: 'fail-open-read', eventName: 'Stop' }, bus },
        {
          readStdinText: async () => {
            throw new Error('stdin not available');
          },
        },
      ),
    ).resolves.toBeUndefined();

    cleanup();

    // Still emitted with an empty payload — the bridge never crashes
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ eventName: 'Stop', payload: {} });
  });

  it('still emits when stdin contains invalid JSON', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'fail-open-json');

    const received: unknown[] = [];
    const cleanup = bus.on(subjects.hook.received, ({ payload }) => {
      received.push(payload);
    });

    await expect(
      runClientHookCommand(
        { args: { client: 'fail-open-json', eventName: 'UserPromptSubmit' }, bus },
        { readStdinText: async () => 'not-valid-json' },
      ),
    ).resolves.toBeUndefined();

    cleanup();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ eventName: 'UserPromptSubmit', payload: {} });
  });

  it('resolves without throwing when the bus emit rejects', async () => {
    const emit = vi.fn(async () => {
      throw new Error('bus unavailable');
    });
    const requestOptional = vi.fn(async () => ({ handled: false as const }));

    await expect(
      runClientHookCommand(
        {
          args: { client: 'fail-open-bus', eventName: 'Stop' },
          bus: { emit, requestOptional },
        },
        { readStdinText: async () => '{}' },
      ),
    ).resolves.toBeUndefined();

    expect(emit).toHaveBeenCalledOnce();
  });

  it('resolves without throwing when the bus emit throws synchronously', async () => {
    const bus = createBusInstance();

    // Replace emit with a synchronously-throwing stub via the bus instance type.
    const syncThrowingBus: typeof bus = {
      ...bus,
      emit: () => {
        throw new Error('sync emit failure');
      },
    };

    await expect(
      runClientHookCommand(
        {
          args: { client: 'fail-open-sync', eventName: 'Stop' },
          bus: syncThrowingBus,
        },
        { readStdinText: async () => '{}' },
      ),
    ).resolves.toBeUndefined();
  });

  it('resolves without throwing when the client id is invalid', async () => {
    const bus = createBusInstance();

    await expect(
      runClientHookCommand({ args: { client: '   ', eventName: 'Stop' }, bus }, { readStdinText: async () => '{}' }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Optional metadata flag
// ---------------------------------------------------------------------------

describe('runClientHookCommand — optional metadata', () => {
  it('attaches parsed metadata when metadataJson is a valid JSON object', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'meta-test');

    const received: unknown[] = [];
    const cleanup = bus.on(subjects.hook.received, ({ payload }) => {
      received.push(payload);
    });

    await runClientHookCommand(
      {
        args: { client: 'meta-test', eventName: 'Stop', metadataJson: '{"pid":1234}' },
        bus,
      },
      { readStdinText: async () => '{}' },
    );

    cleanup();

    expect(received[0]).toMatchObject({ metadata: { pid: 1234 } });
  });

  it('omits the metadata field when metadataJson is absent', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'meta-absent');

    const received: unknown[] = [];
    const cleanup = bus.on(subjects.hook.received, ({ payload }) => {
      received.push(payload);
    });

    await runClientHookCommand(
      { args: { client: 'meta-absent', eventName: 'Stop' }, bus },
      { readStdinText: async () => '{}' },
    );

    cleanup();

    expect(received[0]).not.toHaveProperty('metadata');
  });

  it('omits the metadata field when metadataJson is invalid JSON', async () => {
    const bus = createBusInstance();
    const subjects = registerTestClientNamespace(bus, 'meta-invalid');

    const received: unknown[] = [];
    const cleanup = bus.on(subjects.hook.received, ({ payload }) => {
      received.push(payload);
    });

    await runClientHookCommand(
      {
        args: { client: 'meta-invalid', eventName: 'Stop', metadataJson: 'bad-json' },
        bus,
      },
      { readStdinText: async () => '{}' },
    );

    cleanup();

    expect(received[0]).not.toHaveProperty('metadata');
  });
});
