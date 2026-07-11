import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';
import { AuthType, type Config, GeminiChat } from '@google/gemini-cli-core';
import type { GeminiInitConfig, GeminiInitResult } from '../src/utils/init-gemini.js';
import type { SdkEvent } from '../src/namespaces/index.js';

type QueuedTask = () => void;

const lifecycleHarness = vi.hoisted(() => {
  const queuedTasks: QueuedTask[] = [];
  let holdQueue = false;
  return {
    configs: [] as Array<Pick<Config, 'refreshAuth' | 'initialize'>>,
    queuedTasks,
    hold: (): void => {
      holdQueue = true;
    },
    release: (): void => {
      holdQueue = false;
      while (queuedTasks.length > 0) queuedTasks.shift()!();
    },
    reset: (): void => {
      holdQueue = false;
      queuedTasks.length = 0;
    },
    rateLimiter: {
      add: vi.fn(<T>(task: () => Promise<T>): Promise<T> => {
        if (!holdQueue) return task();
        return new Promise<T>((resolve, reject) => {
          queuedTasks.push(() => {
            void task().then(resolve, reject);
          });
        });
      }),
    },
  };
});

const initHarness = vi.hoisted(() => ({
  initGemini: vi.fn<(config: GeminiInitConfig) => Promise<GeminiInitResult>>(),
}));

const environmentHarness = vi.hoisted(() => {
  const queuedScopes: QueuedTask[] = [];
  let holdScope = false;
  return {
    queuedScopes,
    hold: (): void => {
      holdScope = true;
    },
    release: (): void => {
      holdScope = false;
      while (queuedScopes.length > 0) queuedScopes.shift()!();
    },
    reset: (): void => {
      holdScope = false;
      queuedScopes.length = 0;
    },
    run: <T>(_selected: unknown, operation: () => Promise<T> | T): Promise<T> => {
      if (!holdScope) return Promise.resolve().then(operation);
      return new Promise<T>((resolve, reject) => {
        queuedScopes.push(() => {
          void Promise.resolve().then(operation).then(resolve, reject);
        });
      });
    },
  };
});

vi.mock('../src/rate-limiter.js', () => ({ geminiRateLimiter: lifecycleHarness.rateLimiter }));
vi.mock('../src/tool-handling.js', () => ({ fetchToolsForGemini: vi.fn(async () => []) }));
vi.mock('../src/gemini-sdk-environment.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/gemini-sdk-environment.js')>()),
  withGeminiSdkEnvironment: environmentHarness.run,
}));
vi.mock('../src/utils/create-config.js', () => ({
  applyReasoningOverride: vi.fn(),
  createGeminiConfig: vi.fn(() => {
    const config = {
      getSessionId: () => 'gemini-lifecycle-session',
      refreshAuth: vi.fn(async () => undefined),
      initialize: vi.fn(async () => undefined),
    };
    lifecycleHarness.configs.push(config);
    return config;
  }),
}));
vi.mock('../src/utils/init-gemini.js', () => ({ initGemini: initHarness.initGemini }));

import { GeminiConnector } from '../src/connector.js';
import { GeminiConnectorNamespace } from '../src/namespaces/index.js';

class TestGeminiConnector extends GeminiConnector {
  private readonly sdkEvents: SdkEvent[] = [];

  public async initializeForTest(): Promise<void> {
    await this.ensureSession();
  }

  public hasSessionForTest(): boolean {
    return this.getSession() !== undefined;
  }

  public getSdkEventsForTest(): readonly SdkEvent[] {
    return this.sdkEvents;
  }

  protected override async emitSdkEvent(event: SdkEvent): Promise<void> {
    this.sdkEvents.push(event);
  }
}

async function createConnector(agentId: string): Promise<TestGeminiConnector> {
  return new TestGeminiConnector({
    bus: await GeminiConnectorNamespace.scopedBus(),
    adapterId: 'adapter-lifecycle',
    adapterName: 'gemini-sdk',
    agentId,
    model: 'gemini-2.5-flash',
    cwd: os.tmpdir(),
    env: {},
    adapterAuth: {
      processEnv: {},
      connectorDeliveries: [{ target: 'gemini-sdk.refresh-auth', values: { apiKey: 'test-key' } }],
      configInheritance: 'empty',
    } satisfies ResolvedAdapterAuth,
  });
}

function initResult(): GeminiInitResult {
  const geminiChat = Object.create(GeminiChat.prototype) as GeminiChat;
  geminiChat.setSystemInstruction = vi.fn();
  return {
    geminiChat,
    baseSystemInstruction: 'base instruction',
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((resolvePromise) => {
      resolve = resolvePromise;
    }),
    resolve,
  };
}

describe('GeminiConnector initialization lifecycle', () => {
  beforeEach(() => {
    lifecycleHarness.reset();
    environmentHarness.reset();
    lifecycleHarness.configs.length = 0;
    lifecycleHarness.rateLimiter.add.mockClear();
    initHarness.initGemini.mockReset();
    initHarness.initGemini.mockImplementation(async (config) => {
      await config.refreshAuth(AuthType.USE_GEMINI, 'test-key');
      await config.initialize();
      return initResult();
    });
  });

  afterEach(() => {
    lifecycleHarness.release();
    environmentHarness.release();
  });

  it('shares one in-flight initialization across concurrent callers', async () => {
    const connector = await createConnector('agent-single-flight');

    await Promise.all([connector.initializeForTest(), connector.initializeForTest(), connector.initializeForTest()]);

    expect(initHarness.initGemini).toHaveBeenCalledTimes(1);
    expect(lifecycleHarness.configs).toHaveLength(1);
    expect(lifecycleHarness.configs[0]?.refreshAuth).toHaveBeenCalledTimes(1);
    expect(lifecycleHarness.configs[0]?.initialize).toHaveBeenCalledTimes(1);
    expect(connector.getSdkEventsForTest()).toEqual([
      { type: 'session.created', cwd: os.tmpdir(), model: 'gemini-2.5-flash' },
    ]);
    expect(connector.hasSessionForTest()).toBe(true);
  });

  it('clears a failed initialization so the next caller retries', async () => {
    const connector = await createConnector('agent-retry');
    initHarness.initGemini.mockRejectedValueOnce(new Error('initialization failed'));

    await expect(connector.initializeForTest()).rejects.toThrow('initialization failed');
    await connector.initializeForTest();

    expect(initHarness.initGemini).toHaveBeenCalledTimes(2);
    expect(connector.hasSessionForTest()).toBe(true);
  });

  it('makes close await an already-running initialization and prevents session publication', async () => {
    const connector = await createConnector('agent-terminated-running');
    const initialization = deferred<GeminiInitResult>();
    initHarness.initGemini.mockImplementationOnce(async () => await initialization.promise);

    const starting = connector.initializeForTest();
    await vi.waitFor(() => expect(initHarness.initGemini).toHaveBeenCalledTimes(1));
    connector.abort();
    const closing = connector.close();
    let closeSettled = false;
    void closing.then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    initialization.resolve(initResult());
    await expect(starting).rejects.toThrow('Gemini connector is closed.');
    await closing;

    expect(connector.getSdkEventsForTest()).toEqual([]);
    expect(connector.hasSessionForTest()).toBe(false);
  });

  it('skips a queued initialization when termination wins before the queue starts it', async () => {
    const first = await createConnector('agent-queue-owner');
    const firstInitialization = deferred<GeminiInitResult>();
    initHarness.initGemini.mockImplementationOnce(async () => await firstInitialization.promise);
    const firstStart = first.initializeForTest();
    await vi.waitFor(() => expect(initHarness.initGemini).toHaveBeenCalledTimes(1));

    lifecycleHarness.hold();
    const connector = await createConnector('agent-terminated-queued');
    const starting = connector.initializeForTest();
    await vi.waitFor(() => expect(lifecycleHarness.queuedTasks).toHaveLength(1));
    connector.abort();
    const closing = connector.close();
    let closeSettled = false;
    void closing.then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    lifecycleHarness.release();
    await expect(starting).rejects.toThrow('Gemini connector is closed.');
    await closing;
    expect(initHarness.initGemini).toHaveBeenCalledTimes(1);
    expect(connector.getSdkEventsForTest()).toEqual([]);
    expect(connector.hasSessionForTest()).toBe(false);

    firstInitialization.resolve(initResult());
    await firstStart;
    await first.close();
  });

  it('does not enter a queued environment scope after termination', async () => {
    environmentHarness.hold();
    const connector = await createConnector('agent-terminated-environment-scope');
    const starting = connector.initializeForTest();
    await vi.waitFor(() => expect(environmentHarness.queuedScopes).toHaveLength(1));

    connector.abort();
    const closing = connector.close();
    environmentHarness.release();

    await expect(starting).rejects.toThrow('Gemini connector is closed.');
    await closing;
    expect(lifecycleHarness.configs).toEqual([]);
    expect(initHarness.initGemini).not.toHaveBeenCalled();
    expect(connector.getSdkEventsForTest()).toEqual([]);
    expect(connector.hasSessionForTest()).toBe(false);
  });
});
