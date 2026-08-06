import {
  createAdapterNamespace,
  type MessageHandle,
  type ProcessingState,
  type ProceduralConnectorSession,
  type WireSessionConfig,
  type WireSessionSubjects,
} from '@makaio/ai-adapters-core';
import { createTestBusInstance } from '@makaio/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { TurnStateChangedSchema } from '../../namespaces/schemas/turn-state.js';
import {
  BaseStreamConnector,
  type BaseStreamConnectorConfig,
  type StreamConnectorSession,
} from '../base-stream-connector.js';

const TestNamespace = createAdapterNamespace('adapter:streamLifecycleTest', {
  'turn.turn_started': TurnStateChangedSchema,
  'turn.step_started': TurnStateChangedSchema,
  'turn.step_finished': TurnStateChangedSchema,
  'turn.turn_finished': TurnStateChangedSchema,
});

type TestBus = Awaited<ReturnType<typeof TestNamespace.scopedBus>>;

class TestSession implements StreamConnectorSession {
  public abort = vi.fn(async (): Promise<void> => {});
  public close = vi.fn(async (): Promise<void> => {});
  public getCurrentTurn(): undefined {
    return undefined;
  }
  public processQueue = vi.fn(async (): Promise<void> => {});
  public updateCwd(): void {}
  public updateModel(): void {}
}

class TestStreamConnector extends BaseStreamConnector<TestBus, TestSession, BaseStreamConnectorConfig<TestBus>> {
  public createSessionCalls = 0;
  public createdSession?: TestSession;
  public fetchToolsImpl: () => Promise<void> = async () => {};
  public afterEnsureSessionImpl: () => Promise<void> = async () => {};
  public activeStateUpdateImpl: () => Promise<void> = async () => {};
  public onTurnStarted?: () => Promise<void>;

  /**
   * Create a concrete stream connector for the lifecycle contract.
   * @param config - Fully resolved test connector configuration
   */
  public constructor(config: BaseStreamConnectorConfig<TestBus> & { adapterId: string }) {
    super(config);
  }

  public currentSession(): ProceduralConnectorSession | undefined {
    return this.getSession();
  }

  protected async fetchTools(): Promise<void> {
    await this.fetchToolsImpl();
  }

  protected override async ensureSession(): Promise<ProceduralConnectorSession> {
    const session = await super.ensureSession();
    await this.afterEnsureSessionImpl();
    return session;
  }

  public override async updateProcessingState(state: ProcessingState): Promise<void> {
    await super.updateProcessingState(state);
    if (state === 'active') {
      await this.activeStateUpdateImpl();
    }
  }

  protected createSession(): TestSession {
    this.createSessionCalls += 1;
    this.createdSession = new TestSession();
    return this.createdSession;
  }

  protected getTurnSubjects(): WireSessionSubjects<TestBus['namespace']> {
    return TestNamespace.subjects.turn;
  }

  protected override getWireSessionConfig(): WireSessionConfig {
    return { onTurnStarted: this.onTurnStarted };
  }
}

describe('BaseStreamConnector terminal initialization', () => {
  it('does not publish a session or wire turn handlers when close wins during tool fetch', async () => {
    const hostBus = createTestBusInstance();
    const connector = new TestStreamConnector({
      bus: await TestNamespace.scopedBus(hostBus.getContext()),
      globalBus: hostBus,
      adapterId: 'adapter-1',
      adapterName: 'stream-lifecycle-test',
      agentId: 'agent-1',
      model: 'test-model',
      cwd: process.cwd(),
    });
    let releaseFetch: (() => void) | undefined;
    connector.fetchToolsImpl = () =>
      new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });

    const initialization = connector.initialize();
    await vi.waitFor(() => expect(releaseFetch).toBeTypeOf('function'));
    await connector.close();
    releaseFetch?.();

    await expect(initialization).rejects.toThrow('closed connector');
    expect(connector.createSessionCalls).toBe(0);
    expect(connector.currentSession()).toBeUndefined();
  });

  it('settles a send handle when close wins during tool fetch', async () => {
    const hostBus = createTestBusInstance();
    let sentHandle: MessageHandle | undefined;
    const connector = new TestStreamConnector({
      bus: await TestNamespace.scopedBus(hostBus.getContext()),
      globalBus: hostBus,
      adapterId: 'adapter-1',
      adapterName: 'stream-lifecycle-test',
      agentId: 'agent-1',
      model: 'test-model',
      cwd: process.cwd(),
      onMessageSent: (handle) => {
        sentHandle = handle;
      },
    });
    let releaseFetch: (() => void) | undefined;
    connector.fetchToolsImpl = () =>
      new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });

    const sending = connector.sendMessage({
      role: 'user',
      message: 'racing tool fetch',
      blocks: [{ type: 'text', content: 'racing tool fetch' }],
    });
    await vi.waitFor(() => expect(releaseFetch).toBeTypeOf('function'));
    const closing = connector.close();
    if (!releaseFetch) {
      throw new Error('tool fetch gate was not installed');
    }
    releaseFetch();

    await expect(sending).rejects.toThrow('closed connector');
    if (!sentHandle) {
      throw new Error('sendMessage did not create a message handle');
    }
    const completion = await sentHandle.waitForCompletion();
    expect(completion.outcome).toBe('error');
    if (completion.outcome !== 'error' || !(completion.error instanceof Error)) {
      throw new Error('close-racing initialization did not complete with its initialization error');
    }
    expect(completion.error.message).toContain('Cannot initialize a closed connector');
    await closing;

    expect(connector.createSessionCalls).toBe(0);
    expect(connector.currentSession()).toBeUndefined();
  });

  it('rejects a snapshotted turn handler once close takes the terminal latch', async () => {
    const hostBus = createTestBusInstance();
    await TestNamespace.scopedBus(hostBus.getContext());
    let releaseFirstHandler: (() => void) | undefined;
    const firstHandlerStarted = new Promise<void>((resolve) => {
      hostBus.on(TestNamespace.subjects.turn.turn_started, async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseFirstHandler = release;
        });
      });
    });
    const connector = new TestStreamConnector({
      bus: await TestNamespace.scopedBus(hostBus.getContext()),
      globalBus: hostBus,
      adapterId: 'adapter-1',
      adapterName: 'stream-lifecycle-test',
      agentId: 'agent-1',
      model: 'test-model',
      cwd: process.cwd(),
    });
    await connector.initialize();

    const emitting = (await TestNamespace.scopedBus(hostBus.getContext())).emit(
      TestNamespace.subjects.turn.turn_started,
      {
        adapterId: 'adapter-1',
        agentId: 'agent-1',
        oldState: 'idle',
        newState: 'turn_started',
        timestamp: Date.now(),
      },
    );
    await firstHandlerStarted;
    const closing = connector.close();
    releaseFirstHandler?.();

    await Promise.all([emitting, closing]);
    expect(connector.getProcessingState()).toBe('idle');
  });

  it('waits for an active turn handler without letting it mutate after close', async () => {
    const hostBus = createTestBusInstance();
    const connector = new TestStreamConnector({
      bus: await TestNamespace.scopedBus(hostBus.getContext()),
      globalBus: hostBus,
      adapterId: 'adapter-1',
      adapterName: 'stream-lifecycle-test',
      agentId: 'agent-1',
      model: 'test-model',
      cwd: process.cwd(),
    });
    let releaseTurnStart: (() => void) | undefined;
    const turnStartEntered = new Promise<void>((resolve) => {
      connector.onTurnStarted = async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseTurnStart = release;
        });
      };
    });
    await connector.initialize();

    const emitting = (await TestNamespace.scopedBus(hostBus.getContext())).emit(
      TestNamespace.subjects.turn.turn_started,
      {
        adapterId: 'adapter-1',
        agentId: 'agent-1',
        oldState: 'idle',
        newState: 'turn_started',
        timestamp: Date.now(),
      },
    );
    await turnStartEntered;
    const closing = connector.close();
    let closeSettled = false;
    void closing.then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    releaseTurnStart?.();
    await Promise.all([emitting, closing]);
    expect(connector.getProcessingState()).toBe('idle');
  });

  it('rejects a close-racing send before it can process the released session queue', async () => {
    const hostBus = createTestBusInstance();
    const connector = new TestStreamConnector({
      bus: await TestNamespace.scopedBus(hostBus.getContext()),
      globalBus: hostBus,
      adapterId: 'adapter-1',
      adapterName: 'stream-lifecycle-test',
      agentId: 'agent-1',
      model: 'test-model',
      cwd: process.cwd(),
    });
    await connector.initialize();
    const session = connector.createdSession;

    const closing = connector.close();

    await expect(
      connector.sendMessage({
        role: 'user',
        message: 'after close',
        blocks: [{ type: 'text', content: 'after close' }],
      }),
    ).rejects.toThrow('closed connector');
    await closing;

    expect(session?.close).toHaveBeenCalledTimes(1);
    expect(session?.processQueue).not.toHaveBeenCalled();
    expect(connector.currentSession()).toBeUndefined();
  });

  it('settles a send-first, close-second handle without starting provider work', async () => {
    const hostBus = createTestBusInstance();
    let sentHandle: MessageHandle | undefined;
    const connector = new TestStreamConnector({
      bus: await TestNamespace.scopedBus(hostBus.getContext()),
      globalBus: hostBus,
      adapterId: 'adapter-1',
      adapterName: 'stream-lifecycle-test',
      agentId: 'agent-1',
      model: 'test-model',
      cwd: process.cwd(),
      onMessageSent: (handle) => {
        sentHandle = handle;
      },
    });
    await connector.initialize();
    const session = connector.createdSession;
    let releaseEnsureSession: (() => void) | undefined;
    const ensureSessionPaused = new Promise<void>((resolve) => {
      connector.afterEnsureSessionImpl = () =>
        new Promise<void>((release) => {
          releaseEnsureSession = release;
          resolve();
        });
    });

    const sending = connector.sendMessage({
      role: 'user',
      message: 'racing close',
      blocks: [{ type: 'text', content: 'racing close' }],
    });
    await ensureSessionPaused;
    const closing = connector.close();
    if (!releaseEnsureSession) {
      throw new Error('ensureSession gate was not installed');
    }
    releaseEnsureSession();

    await expect(sending).rejects.toThrow('closed connector');
    if (!sentHandle) {
      throw new Error('sendMessage did not create a message handle');
    }
    await expect(sentHandle.waitForCompletion()).resolves.toMatchObject({ outcome: 'error' });
    await closing;

    expect(session?.processQueue).not.toHaveBeenCalled();
    expect(session?.close).toHaveBeenCalledTimes(1);
  });

  it('keeps the session usable after an interrupt', async () => {
    const hostBus = createTestBusInstance();
    const connector = new TestStreamConnector({
      bus: await TestNamespace.scopedBus(hostBus.getContext()),
      globalBus: hostBus,
      adapterId: 'adapter-1',
      adapterName: 'stream-lifecycle-test',
      agentId: 'agent-1',
      model: 'test-model',
      cwd: process.cwd(),
    });
    await connector.initialize();
    const session = connector.createdSession;

    await connector.interrupt();
    await connector.sendMessage({
      role: 'user',
      message: 'after interrupt',
      blocks: [{ type: 'text', content: 'after interrupt' }],
    });

    expect(session?.abort).toHaveBeenCalledTimes(1);
    expect(session?.processQueue).toHaveBeenCalledTimes(1);
    expect(session?.close).not.toHaveBeenCalled();
  });

  it('settles and drains the queue when close wins during active-state transition', async () => {
    const hostBus = createTestBusInstance();
    let sentHandle: MessageHandle | undefined;
    const connector = new TestStreamConnector({
      bus: await TestNamespace.scopedBus(hostBus.getContext()),
      globalBus: hostBus,
      adapterId: 'adapter-1',
      adapterName: 'stream-lifecycle-test',
      agentId: 'agent-1',
      model: 'test-model',
      cwd: process.cwd(),
      onMessageSent: (handle) => {
        sentHandle = handle;
      },
    });
    await connector.initialize();
    const session = connector.createdSession;
    let releaseActiveStateUpdate: (() => void) | undefined;
    const activeStateUpdatePaused = new Promise<void>((resolve) => {
      connector.activeStateUpdateImpl = () =>
        new Promise<void>((release) => {
          releaseActiveStateUpdate = release;
          resolve();
        });
    });

    const sending = connector.sendMessage({
      role: 'user',
      message: 'racing active state',
      blocks: [{ type: 'text', content: 'racing active state' }],
    });
    await activeStateUpdatePaused;
    const closing = connector.close();
    if (!releaseActiveStateUpdate) {
      throw new Error('active-state transition gate was not installed');
    }
    releaseActiveStateUpdate();

    await expect(sending).rejects.toThrow('closed connector');
    if (!sentHandle) {
      throw new Error('sendMessage did not create a message handle');
    }
    await expect(sentHandle.waitForCompletion()).resolves.toMatchObject({ outcome: 'error' });
    await closing;

    expect(session?.processQueue).not.toHaveBeenCalled();
    expect(session?.close).toHaveBeenCalledTimes(1);
  });
});
