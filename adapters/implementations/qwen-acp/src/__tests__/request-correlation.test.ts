import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import type { AcpConnectionHandle } from '@makaio/ai-adapters-acp-client';
import type { AgentStartResult, NormalizedCallUsage, NormalizedMessageInput } from '@makaio/ai-adapters-core';
import { QwenAcpAgent } from '../agent.js';
import { QwenAcpConnector } from '../connector.js';
import { QwenAcpNamespace } from '../namespaces/index.js';

const mockCreateAcpConnection = vi.hoisted(() => vi.fn());

vi.mock('@makaio/ai-adapters-acp-client', async () => {
  const actual = await vi.importActual<typeof import('@makaio/ai-adapters-acp-client')>(
    '@makaio/ai-adapters-acp-client',
  );
  return {
    ...actual,
    createAcpConnection: mockCreateAcpConnection,
  };
});

const TEST_AGENT_ID = 'agent-qwen-correlation';
const TEST_ADAPTER_ID = 'adapter-qwen-correlation';
const TEST_MODEL = 'qwen3-coder';

const TEST_MESSAGE: NormalizedMessageInput = {
  role: 'user',
  message: 'Hello',
  blocks: [{ type: 'text', content: 'Hello' }],
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

/**
 * Create a promise with an externally accessible resolve function.
 * @returns Deferred promise and its resolver
 */
function createDeferred<T>(): Deferred<T> {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

/**
 * Create a mock ACP connection handle whose `prompt()` resolves only when the
 * returned deferred is released, so tests can drive session updates mid-turn.
 * @param sessionId - Session id returned by newSession()
 * @param promptReleased - Deferred gating the `prompt()` resolution
 * @returns ACP handle used by connector initialization
 */
function makeAcpHandle(sessionId: string, promptReleased: Deferred<void>): AcpConnectionHandle {
  return {
    // @ts-expect-error -- partial platform shim; ClientSideConnection has private fields and many more members not needed here
    connection: {
      initialize: vi.fn().mockResolvedValue(undefined),
      newSession: vi.fn().mockResolvedValue({ sessionId }),
      cancel: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockReturnValue(promptReleased.promise),
    },
    kill: vi.fn(),
    exited: Promise.resolve(0),
  };
}

/**
 * Create a fully wired QwenAcpAgent backed by a real QwenAcpConnector.
 *
 * Only the ACP client layer is mocked (via `createAcpConnection`); the agent,
 * connector, AgentEventBridge, and MessageLifecycleTracker are the real
 * shared-core implementations, so usage attribution flows the production path.
 * @returns Agent, its connector, and the deferred releasing the first prompt
 */
async function makeAgent(): Promise<{
  agent: QwenAcpAgent;
  connector: QwenAcpConnector;
  acpHandle: AcpConnectionHandle;
  promptReleased: Deferred<void>;
}> {
  const promptReleased = createDeferred<void>();
  const acpHandle = makeAcpHandle('acp-session-1', promptReleased);
  mockCreateAcpConnection.mockResolvedValueOnce(acpHandle);

  const adapterBus = await QwenAcpNamespace.scopedBus();
  let connector: QwenAcpConnector | undefined;
  const agent = new QwenAcpAgent({
    agentId: TEST_AGENT_ID,
    adapterId: TEST_ADAPTER_ID,
    adapterName: 'qwen-acp',
    adapterBus,
    globalBus: MakaioBus,
    sessionId: 'session-1',
    cwd: tmpdir(),
    model: TEST_MODEL,
    capabilities: [],
    nativeTools: [],
    configFactory: async (input) => ({
      ...input,
      adapterId: TEST_ADAPTER_ID,
      model: input.model ?? TEST_MODEL,
      cwd: input.cwd ?? tmpdir(),
      env: input.env ?? {},
      allowedDirectories: input.allowedDirectories ?? [],
    }),
    connectorFactory: (config) => {
      connector = new QwenAcpConnector(config);
      return connector;
    },
  });

  await agent.init();
  if (!connector) throw new Error('connectorFactory was not invoked during init()');
  return { agent, connector, acpHandle, promptReleased };
}

/**
 * Start a real turn through the public agent API with the given correlation
 * context and wait until the connector has dispatched the ACP prompt.
 * @param agent - Agent under test
 * @param acpHandle - Mock ACP handle used to detect prompt dispatch
 * @param requestCorrelation - Orchestrator-supplied correlation for the turn
 * @returns Start result containing the live message handle
 */
async function startTurnWithCorrelation(
  agent: QwenAcpAgent,
  acpHandle: AcpConnectionHandle,
  requestCorrelation: { executionId: string; frameId: string },
): Promise<AgentStartResult> {
  const startResult = await agent.start(TEST_MESSAGE, {
    sessionContext: { isFirstTurn: true, requestCorrelation },
  });
  await vi.waitFor(() => {
    expect(acpHandle.connection.prompt).toHaveBeenCalledTimes(1);
  });
  return startResult;
}

describe('QwenAcpAgent shared-core usage attribution', () => {
  const usageEvents: Array<Record<string, unknown>> = [];
  let closeAgent: (() => Promise<void>) | undefined;

  beforeEach(() => {
    mockCreateAcpConnection.mockReset();
    MakaioBus.__resetHandlers?.();
    usageEvents.length = 0;
    MakaioBus.on(AgentSubjects.usage, (ctx) => {
      usageEvents.push(ctx.payload as Record<string, unknown>);
    });
  });

  afterEach(async () => {
    await closeAgent?.();
    closeAgent = undefined;
    MakaioBus.__resetHandlers?.();
    vi.restoreAllMocks();
  });

  it('enriches flushed turn usage with executionId/frameId from the active message handle', async () => {
    const { agent, connector, acpHandle, promptReleased } = await makeAgent();
    closeAgent = () => agent.close();

    const startResult = await startTurnWithCorrelation(agent, acpHandle, {
      executionId: 'execution-1',
      frameId: 'frame-1',
    });

    // Real ACP notification path: per-chunk _meta.usage accumulates in the
    // connector and flushes as a single session_update_usage at turn end.
    await connector['onSessionUpdate']({
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
        _meta: { usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      },
    });

    promptReleased.resolve();
    await startResult.messageHandle.waitForCompletion();

    await vi.waitFor(() => expect(usageEvents).toHaveLength(1));
    expect(usageEvents[0]).toMatchObject({
      agentId: TEST_AGENT_ID,
      granularity: 'turn-aggregate',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      executionId: 'execution-1',
      frameId: 'frame-1',
    });
  });

  it('does not overwrite provider-supplied executionId/frameId with handle correlation', async () => {
    const { agent, acpHandle, promptReleased } = await makeAgent();
    closeAgent = () => agent.close();

    const startResult = await startTurnWithCorrelation(agent, acpHandle, {
      executionId: 'handle-execution',
      frameId: 'handle-frame',
    });

    // Simulate a provider that already correlates its usage natively — the
    // normalized payload arrives at the shared-core trackUsage seam with its
    // own executionId/frameId while the real turn handle is still active.
    const providerNormalized: NormalizedCallUsage = {
      provider: 'qwen',
      granularity: 'turn-aggregate',
      inputTokens: 1,
      inputCachedTokens: 0,
      outputTokens: 2,
      reasoningTokens: 0,
      totalTokens: 3,
      costUnits: 3,
      costUnitType: 'tokens',
      executionId: 'provider-execution',
      frameId: 'provider-frame',
    };
    await agent['trackUsage'](providerNormalized);

    await vi.waitFor(() => expect(usageEvents).toHaveLength(1));
    expect(usageEvents[0]).toMatchObject({
      executionId: 'provider-execution',
      frameId: 'provider-frame',
    });

    promptReleased.resolve();
    await startResult.messageHandle.waitForCompletion();
  });

  it('emits usage without executionId/frameId when no turn handle is active', async () => {
    const { agent, connector, acpHandle, promptReleased } = await makeAgent();
    closeAgent = () => agent.close();

    const startResult = await startTurnWithCorrelation(agent, acpHandle, {
      executionId: 'execution-late',
      frameId: 'frame-late',
    });
    promptReleased.resolve();
    await startResult.messageHandle.waitForCompletion();
    await agent.complete();

    // Late usage arriving after turn completion: re-arm the accumulator and
    // flush through the real connector emission path — the agent subscription
    // normalizes and calls trackUsage with no active handle to enrich from.
    connector['turnUsageAccumulator'] = {};
    await connector['onSessionUpdate']({
      sessionId: 'acp-session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'late' },
        _meta: { usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } },
      },
    });
    await connector['flushAccumulatedUsage'](Date.now());

    await vi.waitFor(() =>
      expect(usageEvents.some((event) => event['inputTokens'] === 7 && event['outputTokens'] === 3)).toBe(true),
    );
    const lateUsage = usageEvents.find((event) => event['inputTokens'] === 7);
    expect(lateUsage).toBeDefined();
    expect(lateUsage).not.toHaveProperty('executionId');
    expect(lateUsage).not.toHaveProperty('frameId');
  });
});
