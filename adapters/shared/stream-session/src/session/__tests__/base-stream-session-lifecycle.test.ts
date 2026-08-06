import {
  createAdapterNamespace,
  MessageHandle,
  ProceduralConnectorTurn,
  SESSION_CLOSED_QUEUE_ERROR,
  UserMessageQueue,
} from '@makaio/ai-adapters-core';
import { createTestBusInstance } from '@makaio/test-utils';
import { describe, expect, it } from 'vitest';
import { TurnStateChangedSchema } from '../../namespaces/schemas/turn-state.js';
import { BaseStreamSession, type StreamSessionTurn } from '../base-stream-session.js';
import type { StreamSessionConfig } from '../types.js';

const TestNamespace = createAdapterNamespace('adapter:streamSessionLifecycleTest', {
  'turn.state_changed': TurnStateChangedSchema,
  'turn.turn_started': TurnStateChangedSchema,
  'turn.step_started': TurnStateChangedSchema,
  'turn.step_finished': TurnStateChangedSchema,
  'turn.turn_finished': TurnStateChangedSchema,
});

type TestBus = Awaited<ReturnType<typeof TestNamespace.scopedBus>>;

class TestStreamTurn extends ProceduralConnectorTurn implements StreamSessionTurn {
  private readonly abortController = new AbortController();

  public constructor(bus: TestBus, handle: MessageHandle) {
    super(
      {
        bus,
        adapterId: 'adapter-1',
        adapterName: 'stream-session-lifecycle-test',
        agentId: 'agent-1',
        messageHandle: handle,
        turnSubjects: TestNamespace.subjects.turn,
      },
      'idle',
    );
  }

  public getAbortSignal(): AbortSignal {
    return this.abortController.signal;
  }
}

class TestStreamSession extends BaseStreamSession<StreamSessionConfig<TestBus>, TestStreamTurn> {
  public runTurnCalls = 0;
  public providerIterationCalls = 0;

  protected createTurn(handle: MessageHandle): TestStreamTurn {
    return new TestStreamTurn(this.bus, handle);
  }

  protected buildMessages(): void {}

  protected getConversationHistoryLength(): number {
    return 0;
  }

  protected replaceAssistantTurnHistory(): void {}

  protected async executeApiCall(
    _turn: TestStreamTurn,
    _abortSignal: AbortSignal,
    _adapterSessionId: string,
  ): Promise<void> {
    this.providerIterationCalls += 1;
  }

  protected getSdkEventSubject() {
    return TestNamespace.subjects.turn.turn_finished;
  }

  protected async applyMessageComplete(): Promise<void> {}

  protected classifyError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  protected override async runTurn(turn: TestStreamTurn): Promise<void> {
    this.runTurnCalls += 1;
    await this.executeApiCall(turn, turn.getAbortSignal(), 'adapter-session-1');
  }
}

describe('BaseStreamSession terminal setup gate', () => {
  it('continues scheduling turns after a reusable abort', async () => {
    const hostBus = createTestBusInstance();
    const bus = await TestNamespace.scopedBus(hostBus.getContext());
    const session = new TestStreamSession({
      bus,
      adapterId: 'adapter-1',
      adapterName: 'stream-session-lifecycle-test',
      agentId: 'agent-1',
      cwd: process.cwd(),
      model: 'test-model',
      env: {},
      emitSdkEvent: async () => {},
      handleError: () => {},
    });
    const handle = new MessageHandle(
      'message-after-abort',
      { role: 'user', message: 'after abort', blocks: [{ type: 'text', content: 'after abort' }] },
      'enqueue',
    );
    const queue = new UserMessageQueue();
    queue.enqueue(handle);

    await session.abort();
    await session.processQueue(queue);
    await Promise.resolve();

    await expect(handle.waitForCompletion()).resolves.toMatchObject({ outcome: 'completed' });
    expect(session.runTurnCalls).toBe(1);
    expect(session.providerIterationCalls).toBe(1);
  });

  it('does not schedule a provider turn when close wins during agent_started emission', async () => {
    const hostBus = createTestBusInstance();
    const bus = await TestNamespace.scopedBus(hostBus.getContext());
    let signalAgentStarted: (() => void) | undefined;
    const agentStarted = new Promise<void>((resolve) => {
      signalAgentStarted = resolve;
    });
    let releaseAgentStarted: (() => void) | undefined;
    const session = new TestStreamSession({
      bus,
      adapterId: 'adapter-1',
      adapterName: 'stream-session-lifecycle-test',
      agentId: 'agent-1',
      cwd: process.cwd(),
      model: 'test-model',
      env: {},
      emitSdkEvent: async () => {
        signalAgentStarted?.();
        await new Promise<void>((resolve) => {
          releaseAgentStarted = resolve;
        });
      },
      handleError: () => {},
    });
    const handle = new MessageHandle(
      'message-1',
      { role: 'user', message: 'close race', blocks: [{ type: 'text', content: 'close race' }] },
      'enqueue',
    );
    const queue = new UserMessageQueue();
    queue.enqueue(handle);

    const processing = session.processQueue(queue);
    await agentStarted;
    const closing = session.close();
    if (!releaseAgentStarted) {
      throw new Error('agent_started emission gate was not installed');
    }
    releaseAgentStarted();

    await Promise.all([processing, closing]);
    await expect(handle.waitForCompletion()).resolves.toMatchObject({
      outcome: 'error',
      error: expect.objectContaining({ message: SESSION_CLOSED_QUEUE_ERROR }),
    });
    expect(session.runTurnCalls).toBe(0);
    expect(session.providerIterationCalls).toBe(0);
  });
});
