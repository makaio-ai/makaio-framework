/**
 * Tests for the runtime observation producer path in the client hook bridge.
 *
 * Verifies that `runClientHookCommand` fires a best-effort
 * `client.runtime.observe` request when the `--metadata-json` flag contains
 * hard runtime evidence (`pid`, `supervisorSessionId`, or `adapterSessionId`),
 * and that it stays silent when no evidence is present.
 *
 * Each test wires a real `createBusInstance()` with a handler registered for
 * `ClientSubjects.runtime.observe` so the full request path is exercised
 * without relying on the `ClientRuntimeService` implementation.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/subsystem-client';
import type { ClientRuntimeObserveRequest } from '@makaio/contracts/client';
import { runClientHookCommand } from '../cli/client-hook-command.js';

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Build a fake `client.runtime.observe` response so the registered handler
 * can call `ctx.setResult()` and satisfy the request contract.
 */
const fakeObserveResponse = {
  clientRuntimeId: 'test-runtime-id',
  created: true,
  promoted: false,
};

// ---------------------------------------------------------------------------
// Producer path: hard evidence present
// ---------------------------------------------------------------------------

describe('runClientHookCommand — runtime.observe producer', () => {
  it('fires client.runtime.observe when metadata contains pid', async () => {
    const bus = createBusInstance();
    const requests: ClientRuntimeObserveRequest[] = [];

    const cleanup = bus.on(ClientSubjects.runtime.observe, (ctx) => {
      requests.push(ctx.payload);
      ctx.setResult(fakeObserveResponse);
    });

    await runClientHookCommand(
      {
        args: {
          client: 'claude-code',
          eventName: 'PostToolUse',
          metadataJson: JSON.stringify({ pid: 12345 }),
        },
        bus,
      },
      { readStdinText: async () => '{}' },
    );

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    cleanup();

    expect(requests[0]).toMatchObject({
      clientId: 'claude-code',
      source: { layer: 'client-hook', producer: 'client-hook-command' },
      pid: 12345,
    });
  });

  it('fires client.runtime.observe when metadata contains supervisorSessionId', async () => {
    const bus = createBusInstance();
    const requests: ClientRuntimeObserveRequest[] = [];

    const cleanup = bus.on(ClientSubjects.runtime.observe, (ctx) => {
      requests.push(ctx.payload);
      ctx.setResult(fakeObserveResponse);
    });

    await runClientHookCommand(
      {
        args: {
          client: 'codex',
          eventName: 'session_started',
          metadataJson: JSON.stringify({ supervisorSessionId: 'sup-sess-abc' }),
        },
        bus,
      },
      { readStdinText: async () => '{}' },
    );

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    cleanup();

    expect(requests[0]).toMatchObject({
      clientId: 'codex',
      supervisorSessionId: 'sup-sess-abc',
    });
    expect(requests[0]?.pid).toBeUndefined();
  });

  it('fires client.runtime.observe when metadata contains adapterSessionId', async () => {
    const bus = createBusInstance();
    const requests: ClientRuntimeObserveRequest[] = [];

    const cleanup = bus.on(ClientSubjects.runtime.observe, (ctx) => {
      requests.push(ctx.payload);
      ctx.setResult(fakeObserveResponse);
    });

    await runClientHookCommand(
      {
        args: {
          client: 'claude-code',
          eventName: 'PreToolUse',
          metadataJson: JSON.stringify({ adapterSessionId: 'adapter-sess-xyz' }),
        },
        bus,
      },
      { readStdinText: async () => '{}' },
    );

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    cleanup();

    expect(requests[0]).toMatchObject({
      clientId: 'claude-code',
      adapterSessionId: 'adapter-sess-xyz',
    });
  });

  it('includes observedAt as a numeric epoch timestamp in the observation', async () => {
    const bus = createBusInstance();
    const requests: ClientRuntimeObserveRequest[] = [];

    const cleanup = bus.on(ClientSubjects.runtime.observe, (ctx) => {
      requests.push(ctx.payload);
      ctx.setResult(fakeObserveResponse);
    });

    const before = Date.now();
    await runClientHookCommand(
      {
        args: {
          client: 'claude-code',
          eventName: 'Stop',
          metadataJson: JSON.stringify({ pid: 9999 }),
        },
        bus,
      },
      { readStdinText: async () => '{}' },
    );
    const after = Date.now();

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    cleanup();

    expect(requests[0]?.observedAt).toBeGreaterThanOrEqual(before);
    expect(requests[0]?.observedAt).toBeLessThanOrEqual(after);
  });

  it('forwards all three evidence fields when all are present', async () => {
    const bus = createBusInstance();
    const requests: ClientRuntimeObserveRequest[] = [];

    const cleanup = bus.on(ClientSubjects.runtime.observe, (ctx) => {
      requests.push(ctx.payload);
      ctx.setResult(fakeObserveResponse);
    });

    await runClientHookCommand(
      {
        args: {
          client: 'claude-code',
          eventName: 'PostToolUse',
          metadataJson: JSON.stringify({
            pid: 42,
            supervisorSessionId: 'sup-1',
            adapterSessionId: 'adapt-1',
          }),
        },
        bus,
      },
      { readStdinText: async () => '{}' },
    );

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    cleanup();

    expect(requests[0]).toMatchObject({
      pid: 42,
      supervisorSessionId: 'sup-1',
      adapterSessionId: 'adapt-1',
    });
  });

  it('passes the full metadata record through in the observation payload', async () => {
    const bus = createBusInstance();
    const requests: ClientRuntimeObserveRequest[] = [];

    const cleanup = bus.on(ClientSubjects.runtime.observe, (ctx) => {
      requests.push(ctx.payload);
      ctx.setResult(fakeObserveResponse);
    });

    await runClientHookCommand(
      {
        args: {
          client: 'claude-code',
          eventName: 'Stop',
          metadataJson: JSON.stringify({ pid: 1, extra: 'context', nested: { a: 1 } }),
        },
        bus,
      },
      { readStdinText: async () => '{}' },
    );

    await vi.waitFor(() => expect(requests).toHaveLength(1));
    cleanup();

    expect(requests[0]?.metadata).toMatchObject({ pid: 1, extra: 'context', nested: { a: 1 } });
  });
});

// ---------------------------------------------------------------------------
// No observation when evidence is absent
// ---------------------------------------------------------------------------

describe('runClientHookCommand — runtime.observe suppressed without evidence', () => {
  it('does NOT fire client.runtime.observe when metadataJson is absent', async () => {
    const bus = createBusInstance();
    const requests: unknown[] = [];

    const cleanup = bus.on(ClientSubjects.runtime.observe, (ctx) => {
      requests.push(ctx.payload);
      ctx.setResult(fakeObserveResponse);
    });

    await runClientHookCommand(
      { args: { client: 'claude-code', eventName: 'Stop' }, bus },
      { readStdinText: async () => '{}' },
    );

    cleanup();

    expect(requests).toHaveLength(0);
  });

  it('does NOT fire client.runtime.observe when metadata has no evidence fields', async () => {
    const bus = createBusInstance();
    const requests: unknown[] = [];

    const cleanup = bus.on(ClientSubjects.runtime.observe, (ctx) => {
      requests.push(ctx.payload);
      ctx.setResult(fakeObserveResponse);
    });

    await runClientHookCommand(
      {
        args: {
          client: 'claude-code',
          eventName: 'Stop',
          metadataJson: JSON.stringify({ hookName: 'PostToolUse', version: '1.0' }),
        },
        bus,
      },
      { readStdinText: async () => '{}' },
    );

    cleanup();

    expect(requests).toHaveLength(0);
  });

  it('does NOT fire client.runtime.observe when metadataJson is invalid JSON', async () => {
    const bus = createBusInstance();
    const requests: unknown[] = [];

    const cleanup = bus.on(ClientSubjects.runtime.observe, (ctx) => {
      requests.push(ctx.payload);
      ctx.setResult(fakeObserveResponse);
    });

    await runClientHookCommand(
      {
        args: { client: 'claude-code', eventName: 'Stop', metadataJson: 'not-json' },
        bus,
      },
      { readStdinText: async () => '{}' },
    );

    cleanup();

    expect(requests).toHaveLength(0);
  });

  it('does NOT fire client.runtime.observe when string evidence is blank', async () => {
    const bus = createBusInstance();
    const requests: unknown[] = [];

    const cleanup = bus.on(ClientSubjects.runtime.observe, (ctx) => {
      requests.push(ctx.payload);
      ctx.setResult(fakeObserveResponse);
    });

    await runClientHookCommand(
      {
        args: {
          client: 'claude-code',
          eventName: 'Stop',
          metadataJson: JSON.stringify({ supervisorSessionId: '   ', adapterSessionId: '' }),
        },
        bus,
      },
      { readStdinText: async () => '{}' },
    );

    cleanup();

    expect(requests).toHaveLength(0);
  });

  it('does NOT fire client.runtime.observe when pid is zero (not positive)', async () => {
    const bus = createBusInstance();
    const requests: unknown[] = [];

    const cleanup = bus.on(ClientSubjects.runtime.observe, (ctx) => {
      requests.push(ctx.payload);
      ctx.setResult(fakeObserveResponse);
    });

    await runClientHookCommand(
      {
        args: {
          client: 'claude-code',
          eventName: 'Stop',
          metadataJson: JSON.stringify({ pid: 0 }),
        },
        bus,
      },
      { readStdinText: async () => '{}' },
    );

    cleanup();

    expect(requests).toHaveLength(0);
  });

  it('does NOT fire client.runtime.observe when pid is a non-integer number', async () => {
    const bus = createBusInstance();
    const requests: unknown[] = [];

    const cleanup = bus.on(ClientSubjects.runtime.observe, (ctx) => {
      requests.push(ctx.payload);
      ctx.setResult(fakeObserveResponse);
    });

    await runClientHookCommand(
      {
        args: {
          client: 'claude-code',
          eventName: 'Stop',
          metadataJson: JSON.stringify({ pid: 12345.6 }),
        },
        bus,
      },
      { readStdinText: async () => '{}' },
    );

    cleanup();

    expect(requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fail-open: observation errors do not surface
// ---------------------------------------------------------------------------

describe('runClientHookCommand — runtime.observe fail-open', () => {
  it('resolves without throwing when no handler is registered for client.runtime.observe', async () => {
    const bus = createBusInstance();

    await expect(
      runClientHookCommand(
        {
          args: {
            client: 'claude-code',
            eventName: 'Stop',
            metadataJson: JSON.stringify({ pid: 1 }),
          },
          bus,
        },
        { readStdinText: async () => '{}' },
      ),
    ).resolves.toBeUndefined();
  });

  it('still emits hook.received even when the observe handler throws', async () => {
    const bus = createBusInstance();
    const { subjects } = (await import('@makaio/subsystem-client')).createClientNamespace('fail-observe-client');
    const hookReceived: unknown[] = [];

    const hookCleanup = bus.on(subjects.hook.received, ({ payload }) => {
      hookReceived.push(payload);
    });
    const observeCleanup = bus.on(ClientSubjects.runtime.observe, (ctx) => {
      ctx.setResult(fakeObserveResponse);
      throw new Error('observe handler failed');
    });

    await expect(
      runClientHookCommand(
        {
          args: {
            client: 'fail-observe-client',
            eventName: 'Stop',
            metadataJson: JSON.stringify({ pid: 1 }),
          },
          bus,
        },
        { readStdinText: async () => '{}' },
      ),
    ).resolves.toBeUndefined();

    hookCleanup();
    observeCleanup();

    expect(hookReceived).toHaveLength(1);
  });

  it('resolves without throwing when requestOptional rejects at the bus level', async () => {
    // Simulate a bus whose requestOptional method itself rejects — e.g. due to
    // a serialisation failure before any handler is invoked. The fire-and-forget
    // `.catch()` in safeEmitRuntimeObserve must absorb this rejection.
    const emit = vi.fn(async () => {});
    const requestOptional = vi.fn(async () => {
      throw new Error('bus-level requestOptional failure');
    });

    await expect(
      runClientHookCommand(
        {
          args: {
            client: 'claude-code',
            eventName: 'Stop',
            metadataJson: JSON.stringify({ pid: 99 }),
          },
          bus: { emit, requestOptional },
        },
        { readStdinText: async () => '{}' },
      ),
    ).resolves.toBeUndefined();
  });
});
