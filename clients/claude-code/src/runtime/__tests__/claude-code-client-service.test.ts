import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/clients-core';
import { type ClientRuntimeStarted, type ClientUsageIngestRequest } from '@makaio/contracts/client';
import { SessionStorageSubjects } from '@makaio/contracts/session';
import { ClaudeCodeClientService } from '../claude-code-client-service.js';
import { ClaudeCodeClientSubjects } from '../namespace.js';
import {
  CLAUDE_CODE_HOOK_SESSION_START,
  CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT,
  CLAUDE_CODE_HOOK_PRE_TOOL_USE,
  CLAUDE_CODE_HOOK_POST_TOOL_USE,
  CLAUDE_CODE_HOOK_STOP,
  CLAUDE_CODE_HOOK_SUBAGENT_STOP,
  CLAUDE_CODE_HOOK_NOTIFICATION,
} from '../schemas.js';

const RECEIVED_AT = 1_713_795_200_000;
const SESSION_ID = 'sess-test-001';

describe('ClaudeCodeClientService', () => {
  let bus: IMakaioBus;
  let service: ClaudeCodeClientService;

  beforeEach(async () => {
    bus = createBusInstance();
    service = new ClaudeCodeClientService(bus);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
  });

  it('emits client.session.started when SessionStart hook is received', async () => {
    const received: unknown[] = [];
    const cleanup = bus.on(ClientSubjects.session.started, ({ payload }) => {
      received.push(payload);
    });

    await bus.emit(ClaudeCodeClientSubjects.hook.received, {
      eventName: CLAUDE_CODE_HOOK_SESSION_START,
      receivedAt: RECEIVED_AT,
      payload: { session_id: SESSION_ID },
    });

    cleanup();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      clientId: 'claude-code',
      source: 'native-hook',
      observedAt: RECEIVED_AT,
      adapterSessionId: SESSION_ID,
    });
  });

  it('emits client.session.userPrompt.submitted with prompt text', async () => {
    const received: unknown[] = [];
    const cleanup = bus.on(ClientSubjects.session.userPrompt.submitted, ({ payload }) => {
      received.push(payload);
    });

    await bus.emit(ClaudeCodeClientSubjects.hook.received, {
      eventName: CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT,
      receivedAt: RECEIVED_AT,
      payload: { session_id: SESSION_ID, prompt: 'Help me debug this' },
    });

    cleanup();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      clientId: 'claude-code',
      source: 'native-hook',
      adapterSessionId: SESSION_ID,
      prompt: 'Help me debug this',
    });
  });

  it('forwards bridge metadata to normalized payloads', async () => {
    const received: unknown[] = [];
    const cleanup = bus.on(ClientSubjects.session.started, ({ payload }) => {
      received.push(payload);
    });

    const metadata = { pid: 9876, invocationId: 'inv-service' };
    await bus.emit(ClaudeCodeClientSubjects.hook.received, {
      eventName: CLAUDE_CODE_HOOK_SESSION_START,
      receivedAt: RECEIVED_AT,
      payload: { session_id: SESSION_ID },
      metadata,
    });

    cleanup();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ metadata });
  });

  it('emits client.session.tool.pre when PreToolUse hook is received', async () => {
    const received: unknown[] = [];
    const cleanup = bus.on(ClientSubjects.session.tool.pre, ({ payload }) => {
      received.push(payload);
    });

    await bus.emit(ClaudeCodeClientSubjects.hook.received, {
      eventName: CLAUDE_CODE_HOOK_PRE_TOOL_USE,
      receivedAt: RECEIVED_AT,
      payload: { session_id: SESSION_ID, tool_name: 'bash', tool_use_id: 'tu-42' },
    });

    cleanup();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      clientId: 'claude-code',
      source: 'native-hook',
      toolName: 'bash',
      toolCallId: 'tu-42',
    });
  });

  it('emits client.session.tool.post with success=true when exit_code is 0', async () => {
    const received: unknown[] = [];
    const cleanup = bus.on(ClientSubjects.session.tool.post, ({ payload }) => {
      received.push(payload);
    });

    await bus.emit(ClaudeCodeClientSubjects.hook.received, {
      eventName: CLAUDE_CODE_HOOK_POST_TOOL_USE,
      receivedAt: RECEIVED_AT,
      payload: { session_id: SESSION_ID, tool_name: 'bash', tool_use_id: 'tu-42', exit_code: 0 },
    });

    cleanup();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      toolName: 'bash',
      toolCallId: 'tu-42',
      success: true,
    });
  });

  it('emits client.session.turn.completed when Stop hook is received', async () => {
    const received: unknown[] = [];
    const cleanup = bus.on(ClientSubjects.session.turn.completed, ({ payload }) => {
      received.push(payload);
    });

    await bus.emit(ClaudeCodeClientSubjects.hook.received, {
      eventName: CLAUDE_CODE_HOOK_STOP,
      receivedAt: RECEIVED_AT,
      payload: { session_id: SESSION_ID },
    });

    cleanup();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      clientId: 'claude-code',
      source: 'native-hook',
      observedAt: RECEIVED_AT,
      adapterSessionId: SESSION_ID,
    });
  });

  it('does not emit any client.session.* event for SubagentStop (raw space only)', async () => {
    const received: unknown[] = [];
    const cleanup = bus.on(ClientSubjects.session.turn.completed, ({ payload }) => {
      received.push(payload);
    });

    await bus.emit(ClaudeCodeClientSubjects.hook.received, {
      eventName: CLAUDE_CODE_HOOK_SUBAGENT_STOP,
      receivedAt: RECEIVED_AT,
      payload: { session_id: SESSION_ID },
    });

    cleanup();

    expect(received).toHaveLength(0);
  });

  it('does not emit any client.session.* event for Notification (Claude-specific raw event)', async () => {
    const sessionEvents: unknown[] = [];

    const cleanups = [
      bus.on(ClientSubjects.session.started, ({ payload }) => {
        sessionEvents.push(payload);
      }),
      bus.on(ClientSubjects.session.userPrompt.submitted, ({ payload }) => {
        sessionEvents.push(payload);
      }),
      bus.on(ClientSubjects.session.turn.started, ({ payload }) => {
        sessionEvents.push(payload);
      }),
      bus.on(ClientSubjects.session.turn.completed, ({ payload }) => {
        sessionEvents.push(payload);
      }),
      bus.on(ClientSubjects.session.tool.pre, ({ payload }) => {
        sessionEvents.push(payload);
      }),
      bus.on(ClientSubjects.session.tool.post, ({ payload }) => {
        sessionEvents.push(payload);
      }),
    ];

    await bus.emit(ClaudeCodeClientSubjects.hook.received, {
      eventName: CLAUDE_CODE_HOOK_NOTIFICATION,
      receivedAt: RECEIVED_AT,
      payload: { session_id: SESSION_ID, message: 'All done' },
    });

    for (const cleanup of cleanups) cleanup();

    expect(sessionEvents).toHaveLength(0);
  });

  it('does not emit any client.session.* event for unknown future hook events', async () => {
    const sessionEvents: unknown[] = [];

    const cleanups = [
      bus.on(ClientSubjects.session.started, ({ payload }) => {
        sessionEvents.push(payload);
      }),
      bus.on(ClientSubjects.session.turn.completed, ({ payload }) => {
        sessionEvents.push(payload);
      }),
    ];

    await bus.emit(ClaudeCodeClientSubjects.hook.received, {
      eventName: 'SomeFutureHookEvent',
      receivedAt: RECEIVED_AT,
      payload: { data: 'unknown' },
    });

    for (const cleanup of cleanups) cleanup();

    expect(sessionEvents).toHaveLength(0);
  });

  it('raw hook.received events are still observable on client:claude-code namespace', async () => {
    const rawEvents: unknown[] = [];
    const cleanup = bus.on(ClaudeCodeClientSubjects.hook.received, ({ payload }) => {
      rawEvents.push(payload);
    });

    await bus.emit(ClaudeCodeClientSubjects.hook.received, {
      eventName: CLAUDE_CODE_HOOK_NOTIFICATION,
      receivedAt: RECEIVED_AT,
      payload: { session_id: SESSION_ID, message: 'Claude-specific event stays raw' },
    });

    cleanup();

    expect(rawEvents).toHaveLength(1);
    expect(rawEvents[0]).toMatchObject({ eventName: CLAUDE_CODE_HOOK_NOTIFICATION });
  });

  it('statusline.received events produce no usage.ingest emission when no session storage handler is registered', async () => {
    // When the storage service is not running (e.g. in early boot or test isolation),
    // requestOptional returns { handled: false } and the service returns early.
    const ingestCalls: unknown[] = [];
    const cleanup = bus.on(ClientSubjects.usage.ingest, (ctx) => {
      ingestCalls.push(ctx.payload);
      ctx.setResult({ clientAccountId: 'ca-1', snapshot: {} as never });
    });

    await bus.emit(ClaudeCodeClientSubjects.statusline.received, {
      session_id: SESSION_ID,
      model: { id: 'claude-opus-4-5', display_name: 'Claude Opus 4.5' },
      rate_limits: { five_hour: { used_percentage: 50, resets_at: 1_738_425_600 } },
    });

    cleanup();

    expect(ingestCalls).toHaveLength(0);
  });

  it('raw statusline.received events are observable on client:claude-code namespace', async () => {
    const rawEvents: unknown[] = [];
    const cleanup = bus.on(ClaudeCodeClientSubjects.statusline.received, ({ payload }) => {
      rawEvents.push(payload);
    });

    await bus.emit(ClaudeCodeClientSubjects.statusline.received, {
      session_id: SESSION_ID,
      model: { id: 'claude-opus-4-5' },
    });

    cleanup();

    expect(rawEvents).toHaveLength(1);
    expect(rawEvents[0]).toMatchObject({ session_id: SESSION_ID });
  });

  describe('statusline ingestion via session-account identity', () => {
    /**
     * Build a minimal session stub with `clientAccountId` and a stored identity
     * observation that carries parseable `identifiers`.
     * @param adapterSessionId - Provider session ID to store on the session
     * @param clientAccountId - Canonical client account ID to link
     * @returns Session stub shaped for `getByAdapterSessionId` responses
     */
    function makeLinkedSession(adapterSessionId: string, clientAccountId: string) {
      return {
        sessionId: 'framework-session-001',
        createdAt: RECEIVED_AT,
        lastActivityAt: RECEIVED_AT,
        agents: [],
        status: 'active' as const,
        adapterSessionId,
        clientId: 'claude-code',
        clientAccountId,
        lastClientIdentityObservation: {
          clientId: 'claude-code',
          source: 'claude-agent-sdk',
          kind: 'account-info',
          observedAt: RECEIVED_AT,
          payload: {
            displayLabel: 'Test User',
            identifiers: [
              {
                scheme: 'account-org-uuid',
                value: 'acct-001:org-001',
                strength: 'strong',
              },
            ],
          },
        },
      };
    }

    it('emits client.usage.ingest when session has clientAccountId and stored identifiers', async () => {
      const ingestCalls: ClientUsageIngestRequest[] = [];

      const cleanups = [
        bus.on(SessionStorageSubjects.getByAdapterSessionId, (ctx) => {
          ctx.setResult({ session: makeLinkedSession(ctx.payload.adapterSessionId, 'client-account-42') });
        }),
        bus.on(ClientSubjects.usage.ingest, (ctx) => {
          ingestCalls.push(ctx.payload);
          ctx.setResult({ clientAccountId: 'client-account-42', snapshot: {} as never });
        }),
      ];

      await bus.emit(ClaudeCodeClientSubjects.statusline.received, {
        session_id: SESSION_ID,
        rate_limits: {
          five_hour: { used_percentage: 35, resets_at: 1_738_425_600 },
          seven_day: { used_percentage: 12, resets_at: 1_738_857_600 },
        },
      });

      for (const cleanup of cleanups) cleanup();

      expect(ingestCalls).toHaveLength(1);
      expect(ingestCalls[0]).toMatchObject({
        clientId: 'claude-code',
        source: 'statusline',
        account: {
          displayLabel: 'Test User',
          identifiers: [{ scheme: 'account-org-uuid', value: 'acct-001:org-001', strength: 'strong' }],
        },
      });
      expect(ingestCalls[0]!.usage.windows).toHaveLength(2);
      expect(ingestCalls[0]!.usage.windows.map((w) => w.key)).toEqual(['five-hour', 'seven-day']);
    });

    it('does not emit client.usage.ingest when session has no clientAccountId', async () => {
      const ingestCalls: unknown[] = [];

      const session = makeLinkedSession(SESSION_ID, 'client-account-42');
      // Remove clientAccountId to simulate a session that has not yet been linked
      const { clientAccountId: _unused, ...sessionWithoutAccount } = session;

      const cleanups = [
        bus.on(SessionStorageSubjects.getByAdapterSessionId, (ctx) => {
          ctx.setResult({ session: sessionWithoutAccount as typeof session });
        }),
        bus.on(ClientSubjects.usage.ingest, (ctx) => {
          ingestCalls.push(ctx.payload);
          ctx.setResult({ clientAccountId: 'ca-unused', snapshot: {} as never });
        }),
      ];

      await bus.emit(ClaudeCodeClientSubjects.statusline.received, {
        session_id: SESSION_ID,
        rate_limits: { five_hour: { used_percentage: 50, resets_at: 1_738_425_600 } },
      });

      for (const cleanup of cleanups) cleanup();

      expect(ingestCalls).toHaveLength(0);
    });

    it('does not emit client.usage.ingest when statusline payload has no session_id', async () => {
      const ingestCalls: unknown[] = [];

      const cleanups = [
        bus.on(SessionStorageSubjects.getByAdapterSessionId, (ctx) => {
          ctx.setResult({ session: makeLinkedSession('some-session', 'client-account-42') });
        }),
        bus.on(ClientSubjects.usage.ingest, (ctx) => {
          ingestCalls.push(ctx.payload);
          ctx.setResult({ clientAccountId: 'ca-unused', snapshot: {} as never });
        }),
      ];

      await bus.emit(ClaudeCodeClientSubjects.statusline.received, {
        // No session_id — service should return early before any storage lookup
        rate_limits: { five_hour: { used_percentage: 50, resets_at: 1_738_425_600 } },
      });

      for (const cleanup of cleanups) cleanup();

      expect(ingestCalls).toHaveLength(0);
    });

    it('does not emit client.usage.ingest when session storage returns null', async () => {
      const ingestCalls: unknown[] = [];

      const cleanups = [
        bus.on(SessionStorageSubjects.getByAdapterSessionId, (ctx) => {
          ctx.setResult({ session: null });
        }),
        bus.on(ClientSubjects.usage.ingest, (ctx) => {
          ingestCalls.push(ctx.payload);
          ctx.setResult({ clientAccountId: 'ca-unused', snapshot: {} as never });
        }),
      ];

      await bus.emit(ClaudeCodeClientSubjects.statusline.received, {
        session_id: SESSION_ID,
        rate_limits: { five_hour: { used_percentage: 50, resets_at: 1_738_425_600 } },
      });

      for (const cleanup of cleanups) cleanup();

      expect(ingestCalls).toHaveLength(0);
    });
  });

  describe('adapter-managed session gate', () => {
    /**
     * Emits a `client.runtime.started` event on the bus with sensible defaults
     * for the adapter-managed session gate tests. Pass `overrides` to vary only
     * the fields relevant to a particular scenario.
     * @param overrides - Partial payload merged over the defaults.
     */
    function emitRuntimeStarted(overrides: Partial<ClientRuntimeStarted> = {}): Promise<void> {
      return bus.emit(ClientSubjects.runtime.started, {
        clientRuntimeId: 'rt-default',
        clientId: 'claude-code',
        status: 'started',
        source: { layer: 'adapter', producer: 'claude-agent-sdk' },
        observedAt: RECEIVED_AT,
        adapterSessionId: SESSION_ID,
        ...overrides,
      });
    }

    it('suppresses client.session.started when adapterSessionId belongs to an adapter-managed runtime', async () => {
      // Simulate the adapter registering a runtime via client.runtime.started
      await emitRuntimeStarted({ clientRuntimeId: 'rt-001' });

      const received: unknown[] = [];
      const cleanup = bus.on(ClientSubjects.session.started, ({ payload }) => {
        received.push(payload);
      });

      await bus.emit(ClaudeCodeClientSubjects.hook.received, {
        eventName: CLAUDE_CODE_HOOK_SESSION_START,
        receivedAt: RECEIVED_AT,
        payload: { session_id: SESSION_ID },
      });

      cleanup();

      expect(received).toHaveLength(0);
    });

    it('emits client.session.started when adapterSessionId is not in the managed set', async () => {
      // Register a different session as adapter-managed
      await emitRuntimeStarted({
        clientRuntimeId: 'rt-002',
        adapterSessionId: 'other-session-id',
      });

      const received: unknown[] = [];
      const cleanup = bus.on(ClientSubjects.session.started, ({ payload }) => {
        received.push(payload);
      });

      await bus.emit(ClaudeCodeClientSubjects.hook.received, {
        eventName: CLAUDE_CODE_HOOK_SESSION_START,
        receivedAt: RECEIVED_AT,
        payload: { session_id: SESSION_ID },
      });

      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        clientId: 'claude-code',
        source: 'native-hook',
        adapterSessionId: SESSION_ID,
      });
    });

    it('emits client.session.started when SessionStart hook has no adapterSessionId', async () => {
      // Register some managed adapter session — must not affect hooks with no session_id
      await emitRuntimeStarted({
        clientRuntimeId: 'rt-003',
        adapterSessionId: 'some-managed-session',
      });

      const received: unknown[] = [];
      const cleanup = bus.on(ClientSubjects.session.started, ({ payload }) => {
        received.push(payload);
      });

      await bus.emit(ClaudeCodeClientSubjects.hook.received, {
        eventName: CLAUDE_CODE_HOOK_SESSION_START,
        receivedAt: RECEIVED_AT,
        // Intentionally omit session_id so adapterSessionId resolves to undefined
        payload: {},
      });

      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ clientId: 'claude-code', source: 'native-hook' });
    });

    it('does not suppress other hook events (e.g. Notification) regardless of managed sessions', async () => {
      // Even if the session is managed, Notification is already ignored by the
      // normalizer — this confirms the gate plays no role for non-SessionStart events
      await emitRuntimeStarted({ clientRuntimeId: 'rt-004' });

      const sessionEvents: unknown[] = [];
      const cleanups = [
        bus.on(ClientSubjects.session.started, ({ payload }) => {
          sessionEvents.push(payload);
        }),
        bus.on(ClientSubjects.session.turn.completed, ({ payload }) => {
          sessionEvents.push(payload);
        }),
      ];

      await bus.emit(ClaudeCodeClientSubjects.hook.received, {
        eventName: CLAUDE_CODE_HOOK_NOTIFICATION,
        receivedAt: RECEIVED_AT,
        payload: { session_id: SESSION_ID, message: 'All done' },
      });

      for (const cleanup of cleanups) cleanup();

      expect(sessionEvents).toHaveLength(0);
    });

    it('fail-open: emits client.session.started when runtime.started event was never observed', async () => {
      // No runtime.started emitted — managed set is empty, so the hook should emit
      const received: unknown[] = [];
      const cleanup = bus.on(ClientSubjects.session.started, ({ payload }) => {
        received.push(payload);
      });

      await bus.emit(ClaudeCodeClientSubjects.hook.received, {
        eventName: CLAUDE_CODE_HOOK_SESSION_START,
        receivedAt: RECEIVED_AT,
        payload: { session_id: SESSION_ID },
      });

      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ adapterSessionId: SESSION_ID });
    });

    it('does not suppress hook events for non-adapter runtime.started sources', async () => {
      // A supervisor observation must not suppress the hook-path emission
      await emitRuntimeStarted({
        clientRuntimeId: 'rt-005',
        source: { layer: 'supervisor', producer: 'test-supervisor' },
        supervisorSessionId: 'sup-session-abc',
      });

      const received: unknown[] = [];
      const cleanup = bus.on(ClientSubjects.session.started, ({ payload }) => {
        received.push(payload);
      });

      await bus.emit(ClaudeCodeClientSubjects.hook.received, {
        eventName: CLAUDE_CODE_HOOK_SESSION_START,
        receivedAt: RECEIVED_AT,
        payload: { session_id: SESSION_ID },
      });

      cleanup();

      expect(received).toHaveLength(1);
    });

    it('does not suppress client.session.started when runtime.started arrives from a different clientId', async () => {
      // A foreign client (e.g. 'codex') registers an adapter-managed runtime
      // that coincidentally carries the same adapterSessionId as the upcoming
      // Claude Code hook.  The service must scope its gate to claude-code events
      // only and must not suppress the hook-path emission.
      await emitRuntimeStarted({
        clientRuntimeId: 'rt-codex-001',
        clientId: 'codex',
      });

      const received: unknown[] = [];
      const cleanup = bus.on(ClientSubjects.session.started, ({ payload }) => {
        received.push(payload);
      });

      await bus.emit(ClaudeCodeClientSubjects.hook.received, {
        eventName: CLAUDE_CODE_HOOK_SESSION_START,
        receivedAt: RECEIVED_AT,
        payload: { session_id: SESSION_ID },
      });

      cleanup();

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        clientId: 'claude-code',
        source: 'native-hook',
        adapterSessionId: SESSION_ID,
      });
    });

    it('tool hook events are forwarded unconditionally even for managed sessions', async () => {
      // tool.pre and tool.post have no adapter-path equivalent; they must never be
      // suppressed regardless of the managed-session gate state
      await emitRuntimeStarted({ clientRuntimeId: 'rt-006' });

      const toolPreEvents: unknown[] = [];
      const toolPostEvents: unknown[] = [];
      const cleanups = [
        bus.on(ClientSubjects.session.tool.pre, ({ payload }) => {
          toolPreEvents.push(payload);
        }),
        bus.on(ClientSubjects.session.tool.post, ({ payload }) => {
          toolPostEvents.push(payload);
        }),
      ];

      await bus.emit(ClaudeCodeClientSubjects.hook.received, {
        eventName: CLAUDE_CODE_HOOK_PRE_TOOL_USE,
        receivedAt: RECEIVED_AT,
        payload: { session_id: SESSION_ID, tool_name: 'bash', tool_use_id: 'tu-1' },
      });

      await bus.emit(ClaudeCodeClientSubjects.hook.received, {
        eventName: CLAUDE_CODE_HOOK_POST_TOOL_USE,
        receivedAt: RECEIVED_AT,
        payload: { session_id: SESSION_ID, tool_name: 'bash', tool_use_id: 'tu-1', exit_code: 0 },
      });

      for (const cleanup of cleanups) cleanup();

      expect(toolPreEvents).toHaveLength(1);
      expect(toolPostEvents).toHaveLength(1);
    });
  });

  it('service lifecycle: not initialized before init(), initialized after', async () => {
    const uninitService = new ClaudeCodeClientService(bus);
    expect(uninitService.initialized).toBe(false);

    await uninitService.init();
    expect(uninitService.initialized).toBe(true);

    await uninitService.destroy();
    expect(uninitService.initialized).toBe(false);
  });

  it('stops emitting after destroy()', async () => {
    const received: unknown[] = [];
    const cleanup = bus.on(ClientSubjects.session.started, ({ payload }) => {
      received.push(payload);
    });

    await service.destroy();

    await bus.emit(ClaudeCodeClientSubjects.hook.received, {
      eventName: CLAUDE_CODE_HOOK_SESSION_START,
      receivedAt: RECEIVED_AT,
      payload: { session_id: SESSION_ID },
    });

    cleanup();

    expect(received).toHaveLength(0);
  });
});
