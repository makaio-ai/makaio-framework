import { MessageHandle, UserMessageQueue, type NormalizedMessageInput } from '@makaio/ai-adapters-core';
import type { CallContext } from '@makaio/contracts';
import { createTestBusInstance, createTestCall } from '@makaio/test-utils';
import type { AgentSession, AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { PiSdkNamespace, PiSdkSubjects } from '../namespaces/index.js';
import { PiConnectorSession } from '../session.js';

const TEST_MESSAGE: NormalizedMessageInput = {
  role: 'user',
  message: 'hello',
  blocks: [{ type: 'text', content: 'hello' }],
};

class FakePiSession {
  private listener?: (event: AgentSessionEvent) => void;

  public readonly agent = {} as AgentSession['agent'];
  public readonly sessionId = 'pi-session-1';

  /**
   * Register the listener invoked by fake SDK events.
   * @param listener - Connector callback for SDK events
   * @returns Function that removes the listener
   */
  public subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  public async prompt(): Promise<void> {
    await new Promise<void>(() => undefined);
  }

  /** Failure this session's abort raises, when a test injects one. */
  public abortFailure: Error | undefined;

  /** How many times the SDK-side disposal ran, so a stage cannot be skipped silently. */
  public disposeCalls = 0;

  public async abort(): Promise<void> {
    if (this.abortFailure !== undefined) throw this.abortFailure;
  }

  public dispose(): void {
    this.disposeCalls += 1;
  }

  public async setModel(): Promise<void> {}

  public setThinkingLevel(): void {}

  /**
   * Deliver an event to the connector as the SDK would.
   * @param event - SDK event to deliver
   */
  public emit(event: AgentSessionEvent): void {
    this.listener?.(event);
  }
}

/** Wait until a synchronous SDK callback has delivered its async bus emission. */
async function flushEvents(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Build a connector session on a real bus with a controllable SDK session.
 * @param piSession - Fake Pi session to inject
 * @returns Initialized connector session and its event bus
 */
async function makeSession(piSession: FakePiSession) {
  const parentBus = createTestBusInstance();
  parentBus.registerNamespaces([PiSdkNamespace.definition]);
  const bus = await PiSdkNamespace.scopedBus(parentBus);
  const observer = parentBus.own('observer');
  const session = new PiConnectorSession({
    bus,
    observerCall: () => observer,
    agentId: 'agent-1',
    adapterId: 'adapter-1',
    adapterName: 'pi-sdk',
    cwd: process.cwd(),
    model: 'test-model',
    env: {},
    requestToolApproval: async () => ({ action: 'allow' }),
    createPiSession: async () => piSession,
  });
  await session.initialize();
  return { session, bus, observer };
}

describe('PiConnectorSession event call context', () => {
  it('keeps a delayed tool completion owned by the superseded message', async () => {
    const piSession = new FakePiSession();
    const { session, bus } = await makeSession(piSession);
    const starts: Array<{ messageId: string; toolCallId: string }> = [];
    const principals: CallContext['principal'][] = [];
    const unsubscribeStarts = bus.on(PiSdkSubjects.tool_started, ({ payload, call }) => {
      starts.push({ messageId: payload.messageId, toolCallId: payload.toolCallId });
      principals.push(call.principal);
    });
    const completions: Array<{ messageId: string; toolCallId: string }> = [];
    const unsubscribe = bus.on(PiSdkSubjects.tool_completed, ({ payload, call }) => {
      completions.push({ messageId: payload.messageId, toolCallId: payload.toolCallId });
      principals.push(call.principal);
    });
    const rawCompletionPrincipals: CallContext['principal'][] = [];
    const unsubscribeRaw = bus.on(PiSdkSubjects.sdk.event, ({ payload, call }) => {
      if (payload.type === 'tool_execution_end' && payload.toolCallId === 'tool-1') {
        rawCompletionPrincipals.push(call.principal);
      }
    });

    try {
      const queue = new UserMessageQueue();
      const original = createTestCall({ principal: { kind: 'test.user', id: 'original-requester' } });
      const next = createTestCall({ principal: { kind: 'test.user', id: 'replacement-requester' } });
      const first = new MessageHandle(original, 'message-old', TEST_MESSAGE, 'enqueue');
      const replacement = new MessageHandle(next, 'message-new', TEST_MESSAGE, 'immediate');
      queue.enqueue(first);
      await session.processQueue(queue);
      await flushEvents();

      piSession.emit({
        type: 'tool_execution_start',
        toolCallId: 'tool-1',
        toolName: 'read_file',
        args: { path: 'old.txt' },
      });
      await flushEvents();

      queue.enqueue(replacement);
      await session.processQueue(queue);
      await flushEvents();

      // An end event without a retained start origin must not inherit the
      // replacement handle's message identity.
      piSession.emit({
        type: 'tool_execution_end',
        toolCallId: 'untracked-tool',
        toolName: 'read_file',
        result: [{ type: 'text', text: 'untracked result' }],
        isError: false,
      });
      await flushEvents();
      expect(completions).toEqual([]);

      piSession.emit({
        type: 'tool_execution_end',
        toolCallId: 'tool-1',
        toolName: 'read_file',
        result: [{ type: 'text', text: 'old result' }],
        isError: false,
      });
      await flushEvents();

      expect(first.supersededBy).toBe(replacement.messageId);
      expect(starts).toEqual([{ messageId: 'message-old', toolCallId: 'tool-1' }]);
      expect(completions).toEqual([{ messageId: 'message-old', toolCallId: 'tool-1' }]);
      expect(principals).toEqual([original.principal, original.principal]);
      expect(rawCompletionPrincipals).toEqual([original.principal]);
    } finally {
      unsubscribeStarts();
      unsubscribe();
      unsubscribeRaw();
      await session.close(createTestCall());
    }
  });

  it('uses the bus observer for a provider queue update outside a turn', async () => {
    const piSession = new FakePiSession();
    const { session, bus, observer } = await makeSession(piSession);
    // Local dispatch derives a new call, so check the explicit send argument as well.
    const emit = vi.spyOn(bus, 'emit');
    const calls: CallContext[] = [];
    const unsubscribe = bus.on(PiSdkSubjects.queue_update, ({ call }) => {
      calls.push(call);
    });
    try {
      piSession.emit({ type: 'queue_update', steering: [], followUp: [] });
      await flushEvents();

      expect(calls).toEqual([{ caller: observer.caller, principal: observer.caller }]);
      expect(emit).toHaveBeenCalledWith(observer, PiSdkSubjects.queue_update, expect.anything());
      expect(emit).toHaveBeenCalledWith(
        observer,
        PiSdkSubjects.sdk.event,
        expect.objectContaining({ type: 'queue_update' }),
      );
    } finally {
      unsubscribe();
      emit.mockRestore();
      await session.close(createTestCall());
    }
  });
});

// Case 206 — no observed class survives a swallowed failure (I29).
describe('PiConnectorSession teardown evidence', () => {
  it('reports `released` when every stage was accounted for', async () => {
    const piSession = new FakePiSession();
    const { session } = await makeSession(piSession);

    const report = await session.close(createTestCall());

    // `released` rests on local evidence: the subscription this session created is
    // cancelled by this session, so no callback can reach it again.
    expect(report).toEqual({ evidence: 'released' });
    expect(piSession.disposeCalls).toBe(1);
  });

  it('claims no observed class when its own abort failed unaccounted for', async () => {
    const piSession = new FakePiSession();
    piSession.abortFailure = new Error('pi abort rejected');
    const { session } = await makeSession(piSession);

    const report = await session.close(createTestCall());

    // The disposal behind the abort still ran, which is why the failure is caught
    // at all; what may not survive it is the observed class.
    expect(piSession.disposeCalls).toBe(1);
    expect(report.evidence).toBe('unknown');
    expect(report.detail).toContain('Pi session abort failed');
  });
});
