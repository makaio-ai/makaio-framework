/**
 * Regression coverage for supervisor-to-native Codex session correlation.
 *
 * The service observes root `SessionStart` hooks and joins their native
 * session identifier to the supervisor identity supplied by hook metadata.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects, type RawClientHookPayload } from '@makaio/subsystem-client';
import type { ClientRuntimeObserveRequest } from '@makaio/contracts/client';
import { CodexClientSessionService } from '../codex-client-session-service.js';
import { CodexClientSubjects } from '../namespace.js';

const fakeObserveResponse = {
  clientRuntimeId: 'runtime-supervisor-identity',
  created: false,
  promoted: false,
};

/**
 * Emit a raw Codex hook through the service's real bus ingress.
 * @param bus - Test bus instance hosting the client session service.
 * @param eventName - Codex-native hook event name.
 * @param payload - Native hook payload forwarded by the hook command.
 * @param metadata - Optional ingress metadata.
 */
function emitRawHook(
  bus: IMakaioBus,
  eventName: string,
  payload: RawClientHookPayload['payload'],
  metadata?: RawClientHookPayload['metadata'],
): Promise<void> {
  return bus.emit(CodexClientSubjects.hook.received, {
    eventName,
    receivedAt: 1_713_795_200_000,
    payload,
    metadata,
  });
}

describe('CodexClientSessionService — supervisor identity correlation', () => {
  let bus: IMakaioBus;
  let service: CodexClientSessionService;
  let cleanups: Array<() => void>;

  beforeEach(async () => {
    bus = createBusInstance();
    service = new CodexClientSessionService(bus);
    cleanups = [];
    await service.init();
  });

  afterEach(async () => {
    cleanups.forEach((cleanup) => cleanup());
    await service.destroy();
    vi.restoreAllMocks();
  });

  /**
   * Capture runtime observations while satisfying the request contract.
   * @returns Captured request payloads.
   */
  function captureRuntimeObservations(): ClientRuntimeObserveRequest[] {
    const requests: ClientRuntimeObserveRequest[] = [];
    cleanups.push(
      bus.on(ClientSubjects.runtime.observe, (ctx) => {
        requests.push(ctx.payload);
        ctx.setResult(fakeObserveResponse);
      }),
    );
    return requests;
  }

  it('joins a root startup hook to its supervisor and native session identities', async () => {
    const requests = captureRuntimeObservations();

    await emitRawHook(
      bus,
      'SessionStart',
      { session_id: 'codex-native-root-1', source: 'startup' },
      { supervisorSessionId: 'supervisor-root-1' },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      clientId: 'codex',
      source: { layer: 'client-hook', producer: 'codex-client-session-service' },
      observedAt: 1_713_795_200_000,
      supervisorSessionId: 'supervisor-root-1',
      adapterSessionId: 'codex-native-root-1',
    });
  });

  it('keeps the same supervisor-to-native join across resume and compaction starts', async () => {
    const requests = captureRuntimeObservations();
    const metadata = { supervisorSessionId: 'supervisor-root-2' };

    await emitRawHook(bus, 'SessionStart', { session_id: 'codex-native-root-2', source: 'startup' }, metadata);
    await emitRawHook(bus, 'SessionStart', { session_id: 'codex-native-root-2', source: 'resume' }, metadata);
    await emitRawHook(bus, 'SessionStart', { session_id: 'codex-native-root-2', source: 'compact' }, metadata);

    expect(requests).toHaveLength(3);
    expect(requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          clientId: 'codex',
          supervisorSessionId: 'supervisor-root-2',
          adapterSessionId: 'codex-native-root-2',
        }),
      ]),
    );
    expect(
      new Set(
        requests.map(({ supervisorSessionId, adapterSessionId }) => `${supervisorSessionId}:${adapterSessionId}`),
      ),
    ).toEqual(new Set(['supervisor-root-2:codex-native-root-2']));
  });

  it('marks only a root clear start as a runtime adapter-session transition', async () => {
    const requests = captureRuntimeObservations();
    const metadata = { supervisorSessionId: 'supervisor-root-clear' };

    await emitRawHook(
      bus,
      'SessionStart',
      { session_id: 'codex-native-root-before-clear', source: 'startup' },
      metadata,
    );
    await emitRawHook(
      bus,
      'SessionStart',
      { session_id: 'codex-native-root-before-clear', source: 'resume' },
      metadata,
    );
    await emitRawHook(
      bus,
      'SessionStart',
      { session_id: 'codex-native-root-before-clear', source: 'compact' },
      metadata,
    );
    await emitRawHook(bus, 'SessionStart', { session_id: 'codex-native-root-after-clear', source: 'clear' }, metadata);

    expect(requests).toEqual([
      expect.objectContaining({
        supervisorSessionId: 'supervisor-root-clear',
        adapterSessionId: 'codex-native-root-before-clear',
      }),
      expect.objectContaining({
        supervisorSessionId: 'supervisor-root-clear',
        adapterSessionId: 'codex-native-root-before-clear',
      }),
      expect.objectContaining({
        supervisorSessionId: 'supervisor-root-clear',
        adapterSessionId: 'codex-native-root-before-clear',
      }),
      expect.objectContaining({
        supervisorSessionId: 'supervisor-root-clear',
        adapterSessionId: 'codex-native-root-after-clear',
        adapterSessionTransition: 'root-clear',
      }),
    ]);
    expect(requests.slice(0, 3).map((request) => request.adapterSessionTransition)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('keeps normal SessionStart normalization when supervisor metadata is absent', async () => {
    const requests = captureRuntimeObservations();
    const startedPayloads: unknown[] = [];
    cleanups.push(
      bus.on(ClientSubjects.session.started, ({ payload }) => {
        startedPayloads.push(payload);
      }),
    );

    await emitRawHook(bus, 'SessionStart', { session_id: 'codex-native-unmanaged', source: 'startup' });

    expect(startedPayloads).toHaveLength(1);
    expect(startedPayloads[0]).toMatchObject({
      clientId: 'codex',
      adapterSessionId: 'codex-native-unmanaged',
      startMode: 'fresh',
    });
    expect(requests).toHaveLength(0);
  });

  it('does not bind a parent supervisor identity from a SubagentStart hook', async () => {
    const requests = captureRuntimeObservations();

    await emitRawHook(
      bus,
      'SubagentStart',
      { session_id: 'codex-native-parent', agent_id: 'codex-native-child', agent_type: 'worker' },
      { supervisorSessionId: 'supervisor-parent' },
    );

    expect(requests).toHaveLength(0);
  });

  it('waits for the root identity join before emitting session.started', async () => {
    const order: string[] = [];
    let resolveJoinRequest!: () => void;
    let releaseJoin!: () => void;
    const joinRequested = new Promise<void>((resolve) => {
      resolveJoinRequest = resolve;
    });
    const joinReleased = new Promise<void>((resolve) => {
      releaseJoin = resolve;
    });
    cleanups.push(
      bus.on(ClientSubjects.runtime.observe, async (ctx) => {
        order.push('runtime.observe');
        resolveJoinRequest();
        await joinReleased;
        ctx.setResult(fakeObserveResponse);
      }),
      bus.on(ClientSubjects.session.started, () => {
        order.push('session.started');
      }),
    );

    const hook = emitRawHook(
      bus,
      'SessionStart',
      { session_id: 'codex-native-ordered', source: 'startup' },
      { supervisorSessionId: 'supervisor-ordered' },
    );

    await joinRequested;
    expect(order).toEqual(['runtime.observe']);

    releaseJoin();
    await hook;

    expect(order).toEqual(['runtime.observe', 'session.started']);
  });

  it('preserves SessionStart normalization and emits a safe warning when the join rejects', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const startedPayloads: unknown[] = [];
    cleanups.push(
      bus.on(ClientSubjects.runtime.observe, () => {
        throw new Error('registry rejected supervisor-secret-1/codex-native-rejected');
      }),
      bus.on(ClientSubjects.session.started, ({ payload }) => {
        startedPayloads.push(payload);
      }),
    );

    await emitRawHook(
      bus,
      'SessionStart',
      { session_id: 'codex-native-rejected', source: 'startup' },
      { supervisorSessionId: 'supervisor-secret-1' },
    );

    expect(startedPayloads).toHaveLength(1);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      '[CodexClientSessionService] Runtime identity join is unavailable.',
    );
  });

  it('preserves SessionStart normalization and emits a safe warning when no join handler exists', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const startedPayloads: unknown[] = [];
    cleanups.push(
      bus.on(ClientSubjects.session.started, ({ payload }) => {
        startedPayloads.push(payload);
      }),
    );

    await emitRawHook(
      bus,
      'SessionStart',
      { session_id: 'codex-native-no-handler', source: 'startup' },
      { supervisorSessionId: 'supervisor-no-handler' },
    );

    expect(startedPayloads).toHaveLength(1);
    expect(warning).toHaveBeenCalledExactlyOnceWith(
      '[CodexClientSessionService] Runtime identity join is unavailable.',
    );
  });
});
