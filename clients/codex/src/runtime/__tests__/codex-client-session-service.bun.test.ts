import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects, type RawClientHookPayload } from '@makaio/clients-core';
import type { ClientRuntimeStarted } from '@makaio/contracts/client';
import { CodexClientSubjects } from '../namespace.js';
import { CodexClientSessionService, MANAGED_SESSION_CAP } from '../codex-client-session-service.js';

type CapturedClientSessionSubject =
  | typeof ClientSubjects.session.started
  | typeof ClientSubjects.session.userPrompt.submitted
  | typeof ClientSubjects.session.turn.started
  | typeof ClientSubjects.session.turn.completed
  | typeof ClientSubjects.session.tool.pre
  | typeof ClientSubjects.session.tool.post;

/**
 * Capture payloads emitted on one or more client session subjects.
 * @param bus - Test bus instance
 * @param subjects - Client session subjects to observe
 * @returns Captured payloads and a cleanup function
 */
function capturePayloads(
  bus: IMakaioBus,
  ...subjects: CapturedClientSessionSubject[]
): { received: unknown[]; cleanup: () => void } {
  const received: unknown[] = [];
  const cleanups = subjects.map((subject) =>
    bus.on(subject, (ctx: { payload: unknown }) => {
      received.push(ctx.payload);
    }),
  );
  return {
    received,
    cleanup: () => {
      cleanups.forEach((cleanup) => cleanup());
    },
  };
}

/**
 * Emit a raw hook event on the test bus and wait for the emission to settle.
 * @param bus - Test bus instance
 * @param eventName - Codex-native hook event name
 * @param payload - Raw payload forwarded by the ingress bridge
 * @param metadata - Optional bridge metadata
 */
async function emitRawHook(
  bus: IMakaioBus,
  eventName: string,
  payload: RawClientHookPayload['payload'] = {},
  metadata?: RawClientHookPayload['metadata'],
): Promise<void> {
  await bus.emit(CodexClientSubjects.hook.received, {
    eventName,
    receivedAt: 1_713_795_200_000,
    payload,
    metadata,
  });
}

describe('CodexClientSessionService', () => {
  let bus: IMakaioBus;
  let service: CodexClientSessionService;

  beforeEach(async () => {
    bus = createBusInstance();
    service = new CodexClientSessionService(bus);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
  });

  it('initializes without errors', () => {
    expect(service.initialized).toBe(true);
  });

  describe('known event normalization', () => {
    it('emits client.session.started for SessionStart', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: 'sess-1' });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        clientId: 'codex',
        source: 'native-hook',
        adapterSessionId: 'sess-1',
      });
    });

    it('emits client.session.userPrompt.submitted for UserPromptSubmit', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.userPrompt.submitted);

      await emitRawHook(bus, 'UserPromptSubmit', {
        session_id: 'sess-2',
        prompt: 'Refactor this file',
      });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        clientId: 'codex',
        source: 'native-hook',
        adapterSessionId: 'sess-2',
        prompt: 'Refactor this file',
      });
    });

    it('emits client.session.turn.completed for Stop', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.turn.completed);

      await emitRawHook(bus, 'Stop', { session_id: 'sess-4' });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ clientId: 'codex', source: 'native-hook' });
    });

    it('emits client.session.tool.pre for PreToolUse', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.tool.pre);

      await emitRawHook(bus, 'PreToolUse', {
        session_id: 'sess-5',
        tool_name: 'bash',
        call_id: 'call-1',
      });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        clientId: 'codex',
        source: 'native-hook',
        toolName: 'bash',
        toolCallId: 'call-1',
      });
    });

    it('emits client.session.tool.post for PostToolUse', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.tool.post);

      await emitRawHook(bus, 'PostToolUse', {
        session_id: 'sess-6',
        tool_name: 'bash',
        call_id: 'call-2',
        success: true,
      });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        clientId: 'codex',
        source: 'native-hook',
        toolName: 'bash',
        toolCallId: 'call-2',
        success: true,
      });
    });
  });

  describe('unknown event handling', () => {
    it('does not emit any client.session.* event for unknown hook names', async () => {
      const { received, cleanup } = capturePayloads(
        bus,
        ClientSubjects.session.started,
        ClientSubjects.session.userPrompt.submitted,
        ClientSubjects.session.turn.started,
        ClientSubjects.session.turn.completed,
        ClientSubjects.session.tool.pre,
        ClientSubjects.session.tool.post,
      );

      await emitRawHook(bus, 'some_future_codex_event');
      await emitRawHook(bus, 'pre_tool_call'); // Old snake_case Codex event — must be ignored
      await emitRawHook(bus, 'unknown_lifecycle_event');

      cleanup();

      expect(received).toHaveLength(0);
    });
  });

  describe('metadata pass-through', () => {
    it('forwards bridge metadata to the normalized payload', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      const metadata = { pid: 99_999, invocationId: 'inv-abc' };
      await emitRawHook(bus, 'SessionStart', {}, metadata);
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ metadata });
    });
  });

  describe('session identifier flow', () => {
    it('propagates session_id through normalization', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: 'sess-flow-1' });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ adapterSessionId: 'sess-flow-1' });
    });

    it('falls back to thread_id when session_id is absent', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.turn.completed);

      await emitRawHook(bus, 'Stop', { thread_id: 'thread-flow-2' });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ adapterSessionId: 'thread-flow-2' });
    });
  });

  describe('lifecycle', () => {
    it('stops forwarding events after destroy()', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await service.destroy();

      await emitRawHook(bus, 'SessionStart');
      cleanup();

      expect(received).toHaveLength(0);
    });
  });

  describe('adapter-managed session gate', () => {
    /**
     * Emits a `client.runtime.started` event on the test bus with sensible
     * defaults for the adapter-managed session gate tests.
     * @param overrides - Partial payload merged over the defaults
     */
    function emitRuntimeStarted(overrides: Partial<ClientRuntimeStarted> = {}): Promise<void> {
      const { source: overrideSource, adapterSessionId: overrideAdapterSessionId, ...rest } = overrides;
      const source = overrideSource ?? { layer: 'adapter', producer: 'codex-app-server' };
      const adapterSessionId = source.layer === 'adapter' ? (overrideAdapterSessionId ?? 'sess-1') : undefined;
      return bus.emit(ClientSubjects.runtime.started, {
        clientRuntimeId: 'rt-default',
        clientId: 'codex',
        status: 'started',
        observedAt: 1_713_795_200_000,
        ...rest,
        source,
        ...(adapterSessionId !== undefined ? { adapterSessionId } : {}),
      });
    }

    it('suppresses client.session.started when adapterSessionId belongs to an adapter-managed runtime', async () => {
      await emitRuntimeStarted({ clientRuntimeId: 'rt-001' });

      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: 'sess-1' });
      cleanup();

      expect(received).toHaveLength(0);
    });

    it('emits client.session.started when adapterSessionId is not in the managed set', async () => {
      await emitRuntimeStarted({ clientRuntimeId: 'rt-002', adapterSessionId: 'other-session' });

      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: 'sess-1' });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ clientId: 'codex', source: 'native-hook', adapterSessionId: 'sess-1' });
    });

    it('emits client.session.started when SessionStart hook has no adapterSessionId', async () => {
      await emitRuntimeStarted({ clientRuntimeId: 'rt-003', adapterSessionId: 'some-managed-session' });

      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', {});
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ clientId: 'codex', source: 'native-hook' });
      expect(received[0]).toMatchObject({ adapterSessionId: undefined });
    });

    it('fail-open: emits client.session.started when runtime.started was never observed', async () => {
      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: 'sess-1' });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ adapterSessionId: 'sess-1' });
    });

    it('does not suppress hook events for non-adapter runtime.started sources', async () => {
      await emitRuntimeStarted({
        clientRuntimeId: 'rt-004',
        source: { layer: 'supervisor', producer: 'test-supervisor' },
        supervisorSessionId: 'sup-session-abc',
      });

      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: 'sess-1' });
      cleanup();

      expect(received).toHaveLength(1);
    });

    it('does not suppress client.session.started when runtime.started arrives from a different clientId', async () => {
      await emitRuntimeStarted({ clientRuntimeId: 'rt-claude-001', clientId: 'claude-code' });

      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: 'sess-1' });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ clientId: 'codex', source: 'native-hook', adapterSessionId: 'sess-1' });
    });

    it('suppresses all normalized client.session events for adapter-managed sessions', async () => {
      await emitRuntimeStarted({ clientRuntimeId: 'rt-005' });

      const { received, cleanup } = capturePayloads(
        bus,
        ClientSubjects.session.userPrompt.submitted,
        ClientSubjects.session.turn.completed,
        ClientSubjects.session.tool.pre,
        ClientSubjects.session.tool.post,
      );

      await emitRawHook(bus, 'UserPromptSubmit', { session_id: 'sess-1', prompt: 'hello' });
      await emitRawHook(bus, 'Stop', { session_id: 'sess-1' });
      await emitRawHook(bus, 'PreToolUse', { session_id: 'sess-1', tool_name: 'bash', call_id: 'c-1' });
      await emitRawHook(bus, 'PostToolUse', { session_id: 'sess-1', tool_name: 'bash', call_id: 'c-1', success: true });

      cleanup();

      expect(received).toHaveLength(0);
    });

    it('evicts the oldest adapter-managed session when the cap is exceeded', async () => {
      for (let index = 0; index <= MANAGED_SESSION_CAP; index++) {
        await emitRuntimeStarted({
          clientRuntimeId: `rt-${index}`,
          adapterSessionId: `managed-session-${index}`,
        });
      }

      const { received, cleanup } = capturePayloads(bus, ClientSubjects.session.started);

      await emitRawHook(bus, 'SessionStart', { session_id: 'managed-session-0' });
      await emitRawHook(bus, 'SessionStart', { session_id: 'managed-session-1' });
      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ adapterSessionId: 'managed-session-0' });
    });
  });
});
