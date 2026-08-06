import { MessageHandle, UserMessageQueue, type NormalizedMessageInput } from '@makaio/ai-adapters-core';
import type { AgentSession, AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import { describe, expect, it } from 'vitest';
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

  public emit(event: AgentSessionEvent): void {
    this.listener?.(event);
  }
}

/** Wait until a synchronous SDK callback has delivered its async bus emission. */
async function flushEvents(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('PiConnectorSession tool event ownership', () => {
  it('keeps a delayed tool completion owned by the superseded message', async () => {
    const bus = await PiSdkNamespace.scopedBus();
    const piSession = new FakePiSession();
    const session = new PiConnectorSession({
      bus,
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'pi-sdk',
      cwd: process.cwd(),
      model: 'test-model',
      env: {},
      requestToolApproval: async () => ({ action: 'allow' }),
      createPiSession: async () => piSession,
    });
    const starts: Array<{ messageId: string; toolCallId: string }> = [];
    const unsubscribeStarts = bus.on(PiSdkSubjects.tool_started, ({ payload }) => {
      starts.push({ messageId: payload.messageId, toolCallId: payload.toolCallId });
    });
    const completions: Array<{ messageId: string; toolCallId: string }> = [];
    const unsubscribe = bus.on(PiSdkSubjects.tool_completed, ({ payload }) => {
      completions.push({ messageId: payload.messageId, toolCallId: payload.toolCallId });
    });

    try {
      await session.initialize();
      const queue = new UserMessageQueue();
      const first = new MessageHandle('message-old', TEST_MESSAGE, 'enqueue');
      const replacement = new MessageHandle('message-new', TEST_MESSAGE, 'immediate');
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
    } finally {
      unsubscribeStarts();
      unsubscribe();
      await session.close();
    }
  });
});

// Case 206 — no observed class survives a swallowed failure (I29).
describe('PiConnectorSession teardown evidence', () => {
  /**
   * Build a session over a fake Pi session the test controls.
   * @param piSession - Fake Pi session to inject.
   * @returns The initialized connector session.
   */
  async function makeSession(piSession: FakePiSession): Promise<PiConnectorSession> {
    const session = new PiConnectorSession({
      bus: await PiSdkNamespace.scopedBus(),
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
    return session;
  }

  it('reports `released` when every stage was accounted for', async () => {
    const piSession = new FakePiSession();
    const session = await makeSession(piSession);

    const report = await session.close();

    // `released` rests on local evidence: the subscription this session created is
    // cancelled by this session, so no callback can reach it again.
    expect(report).toEqual({ evidence: 'released' });
    expect(piSession.disposeCalls).toBe(1);
  });

  it('claims no observed class when its own abort failed unaccounted for', async () => {
    const piSession = new FakePiSession();
    piSession.abortFailure = new Error('pi abort rejected');
    const session = await makeSession(piSession);

    const report = await session.close();

    // The disposal behind the abort still ran, which is why the failure is caught
    // at all; what may not survive it is the observed class.
    expect(piSession.disposeCalls).toBe(1);
    expect(report.evidence).toBe('unknown');
    expect(report.detail).toContain('Pi session abort failed');
  });
});
