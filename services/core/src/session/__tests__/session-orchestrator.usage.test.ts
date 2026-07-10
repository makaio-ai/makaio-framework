/**
 * SessionOrchestrator tests — usage tracking.
 *
 * Verifies that `agent.usage` events emitted during a turn are accumulated and
 * flushed to `TurnStorageSubjects.complete` on turn completion.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects } from '@makaio/contracts';
import type { IMakaioSession, TurnUsage } from '@makaio/contracts';
import { TurnStorageSubjects } from '../turns/index.js';
import { SessionOrchestrator } from '../session-orchestrator.js';
import { registerMockStorageHandlers } from '../testing/index.js';
import {
  createMockSession,
  createMockAgent,
  resetBusHandlers,
  waitForAsync,
  registerGetSessionHandler,
  registerGetAgentHandler,
  registerSendMessageHandler,
  type UnsubscribeFunction,
} from '../testing/orchestrator-shared.js';

type CompletedUsage = {
  turnId: string | undefined;
  usage: TurnUsage | undefined;
};
type CompletedUsages = CompletedUsage[];

/**
 * Minimal complete-handler that captures `usage` and calls `next()` so the
 * downstream mock storage handler still responds (allowing completeTurn to resolve).
 *
 * Registered BEFORE mock storage handlers so it runs first in the middleware chain.
 * @param completedUsages - Array to push captured usage into
 * @returns Unsubscribe function
 */
function registerCapturingCompleteHandler(completedUsages: CompletedUsages): UnsubscribeFunction {
  return MakaioBus.on(TurnStorageSubjects.complete, async (ctx) => {
    completedUsages.push({ turnId: ctx.payload.turnId, usage: ctx.payload.usage });
    await ctx.next(); // let the mock storage handler respond
  });
}

const BASE_USAGE_EVENT = {
  adapterId: 'adapter-a1',
  adapterName: 'test-adapter',
  adapterSessionId: 'adapter-session',
  provider: 'test',
  model: 'test-model',
  inputCachedTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  costUnits: 0,
  costUnitType: 'tokens' as const,
  granularity: 'provider-call' as const,
};

describe('SessionOrchestrator - Usage Tracking', () => {
  let orchestrator: SessionOrchestrator;
  let unsubscribers: UnsubscribeFunction[];
  let sessions: Map<string, IMakaioSession>;

  beforeEach(() => {
    resetBusHandlers();
    unsubscribers = [];
    sessions = new Map();
    unsubscribers.push(registerGetSessionHandler(sessions));
    unsubscribers.push(registerGetAgentHandler(sessions));
    // NOTE: mock storage must be registered AFTER capturing handlers so our
    // capturing handler runs first (bus middleware chain: first registered = first invoked)
  });

  afterEach(() => {
    orchestrator?.destroy();
    unsubscribers.forEach((u) => u());
  });

  const setupSession = (id: string, agents: ReturnType<typeof createMockAgent>[], leadId: string) => {
    sessions.set(id, createMockSession({ sessionId: id, agents, leadAgentId: leadId }));
  };

  it('passes accumulated usage to TurnStorageSubjects.complete when single agent emits usage', async () => {
    setupSession('s1', [createMockAgent('a1', { role: 'lead' })], 'a1');

    const completedUsages: CompletedUsages = [];
    unsubscribers.push(registerCapturingCompleteHandler(completedUsages));
    unsubscribers.push(registerMockStorageHandlers());
    unsubscribers.push(registerSendMessageHandler());

    orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

    const { turnId } = await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId: 's1',
      message: 'Hello',
    });

    // Emit usage event for agent a1 during the turn
    await MakaioBus.emit(AgentSubjects.usage, {
      agentId: 'a1',
      adapterId: 'adapter-a1',
      adapterName: 'test-adapter',
      adapterSessionId: 'adapter-session-a1',
      turnId,
      provider: 'test-provider',
      model: 'test-model',
      inputTokens: 150,
      inputCachedTokens: 0,
      outputTokens: 75,
      reasoningTokens: 0,
      totalTokens: 225,
      costUnits: 225,
      costUnitType: 'tokens',
      granularity: 'provider-call',
    });

    // Complete the agent turn
    await MakaioBus.emit(AgentSubjects.complete, {
      agentId: 'a1',
      adapterId: 'adapter-a1',
      adapterName: 'test-adapter',
      adapterSessionId: 'adapter-session-a1',
      turnId,
      messageId: 'msg-1',
    });

    await waitForAsync();

    expect(completedUsages).toHaveLength(1);
    expect(completedUsages[0]?.turnId).toBe(turnId);
    expect(completedUsages[0]?.usage).toBeDefined();
    expect(completedUsages[0]?.usage?.total.inputTokens).toBe(150);
    expect(completedUsages[0]?.usage?.total.outputTokens).toBe(75);
    expect(completedUsages[0]?.usage?.byAgent?.['a1']).toEqual({ inputTokens: 150, outputTokens: 75 });
  });

  it('aggregates usage across multiple agents in a multi-agent turn', async () => {
    setupSession('s2', [createMockAgent('a1', { role: 'lead' }), createMockAgent('a2')], 'a1');

    const completedUsages: CompletedUsages = [];
    unsubscribers.push(registerCapturingCompleteHandler(completedUsages));
    unsubscribers.push(registerMockStorageHandlers());
    unsubscribers.push(registerSendMessageHandler());

    orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

    const { turnId } = await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId: 's2',
      message: 'Hello',
      agentIds: 'all',
    });

    await MakaioBus.emit(AgentSubjects.usage, {
      ...BASE_USAGE_EVENT,
      turnId,
      agentId: 'a1',
      inputTokens: 100,
      outputTokens: 40,
    });
    await MakaioBus.emit(AgentSubjects.usage, {
      ...BASE_USAGE_EVENT,
      turnId,
      agentId: 'a2',
      inputTokens: 200,
      outputTokens: 60,
    });

    await MakaioBus.emit(AgentSubjects.complete, {
      agentId: 'a1',
      adapterId: 'adapter-a1',
      adapterName: 'test-adapter',
      adapterSessionId: 'adapter-session',
      turnId,
      messageId: 'msg-1',
    });
    await MakaioBus.emit(AgentSubjects.complete, {
      agentId: 'a2',
      adapterId: 'adapter-a2',
      adapterName: 'test-adapter',
      adapterSessionId: 'adapter-session',
      turnId,
      messageId: 'msg-1',
    });

    await waitForAsync();

    expect(completedUsages).toHaveLength(1);
    expect(completedUsages[0]?.usage?.total.inputTokens).toBe(300);
    expect(completedUsages[0]?.usage?.total.outputTokens).toBe(100);
    expect(completedUsages[0]?.usage?.byAgent?.['a1']).toEqual({ inputTokens: 100, outputTokens: 40 });
    expect(completedUsages[0]?.usage?.byAgent?.['a2']).toEqual({ inputTokens: 200, outputTokens: 60 });
  });

  it('passes undefined usage when no usage events were emitted during the turn', async () => {
    setupSession('s3', [createMockAgent('a1', { role: 'lead' })], 'a1');

    const completedUsages: CompletedUsages = [];
    unsubscribers.push(registerCapturingCompleteHandler(completedUsages));
    unsubscribers.push(registerMockStorageHandlers());
    unsubscribers.push(registerSendMessageHandler());

    orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

    const { turnId } = await MakaioBus.request(SessionSubjects.sendMessage, { sessionId: 's3', message: 'Hello' });

    // No agent.usage events emitted

    await MakaioBus.emit(AgentSubjects.complete, {
      agentId: 'a1',
      adapterId: 'adapter-a1',
      adapterName: 'test-adapter',
      adapterSessionId: 'adapter-session-a1',
      turnId,
      messageId: 'msg-1',
    });

    await waitForAsync();

    expect(completedUsages).toHaveLength(1);
    expect(completedUsages[0]?.usage).toBeUndefined();
  });

  it('isolates usage accumulators between concurrent sessions', async () => {
    setupSession('sx', [createMockAgent('ax', { role: 'lead' })], 'ax');
    setupSession('sy', [createMockAgent('ay', { role: 'lead' })], 'ay');

    const completedPayloads: CompletedUsages = [];
    unsubscribers.push(registerCapturingCompleteHandler(completedPayloads));
    unsubscribers.push(registerMockStorageHandlers());
    unsubscribers.push(registerSendMessageHandler());

    orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

    const { turnId: turnX } = await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId: 'sx',
      message: 'Hello',
    });
    const { turnId: turnY } = await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId: 'sy',
      message: 'Hello',
    });

    // ax emits 100 input, ay emits 999 input — they must not cross-contaminate
    await MakaioBus.emit(AgentSubjects.usage, {
      ...BASE_USAGE_EVENT,
      adapterId: 'adapter',
      turnId: turnX,
      agentId: 'ax',
      inputTokens: 100,
      outputTokens: 0,
    });
    await MakaioBus.emit(AgentSubjects.usage, {
      ...BASE_USAGE_EVENT,
      adapterId: 'adapter',
      turnId: turnY,
      agentId: 'ay',
      inputTokens: 999,
      outputTokens: 0,
    });

    await MakaioBus.emit(AgentSubjects.complete, {
      agentId: 'ax',
      adapterId: 'adapter',
      adapterName: 'test-adapter',
      adapterSessionId: 'session',
      turnId: turnX,
      messageId: 'msg-x',
    });
    await MakaioBus.emit(AgentSubjects.complete, {
      agentId: 'ay',
      adapterId: 'adapter',
      adapterName: 'test-adapter',
      adapterSessionId: 'session',
      turnId: turnY,
      messageId: 'msg-y',
    });

    await waitForAsync();

    const payloadX = completedPayloads.find((p) => p.turnId === turnX);
    const payloadY = completedPayloads.find((p) => p.turnId === turnY);

    expect(payloadX?.usage?.total.inputTokens).toBe(100);
    expect(payloadY?.usage?.total.inputTokens).toBe(999);
  });

  it('drops late usage events that reference an inactive turnId', async () => {
    setupSession('s-late', [createMockAgent('a1', { role: 'lead' })], 'a1');

    const completedUsages: CompletedUsages = [];
    unsubscribers.push(registerCapturingCompleteHandler(completedUsages));
    unsubscribers.push(registerMockStorageHandlers());
    unsubscribers.push(registerSendMessageHandler());

    orchestrator = new SessionOrchestrator(MakaioBus, 'test-machine');

    const { turnId: firstTurnId } = await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId: 's-late',
      message: 'first',
    });

    await MakaioBus.emit(AgentSubjects.complete, {
      agentId: 'a1',
      adapterId: 'adapter-a1',
      adapterName: 'test-adapter',
      adapterSessionId: 'adapter-session-a1',
      messageId: 'msg-1',
      turnId: firstTurnId,
    });

    const { turnId: secondTurnId } = await MakaioBus.request(SessionSubjects.sendMessage, {
      sessionId: 's-late',
      message: 'second',
    });

    // Late usage from the previous turn should not be attributed to the current turn.
    await MakaioBus.emit(AgentSubjects.usage, {
      agentId: 'a1',
      adapterId: 'adapter-a1',
      adapterName: 'test-adapter',
      adapterSessionId: 'adapter-session-a1',
      provider: 'test-provider',
      model: 'test-model',
      inputTokens: 999,
      inputCachedTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 999,
      costUnits: 999,
      costUnitType: 'tokens',
      granularity: 'provider-call',
      turnId: firstTurnId,
    });

    await MakaioBus.emit(AgentSubjects.complete, {
      agentId: 'a1',
      adapterId: 'adapter-a1',
      adapterName: 'test-adapter',
      adapterSessionId: 'adapter-session-a1',
      messageId: 'msg-2',
      turnId: secondTurnId,
    });

    await waitForAsync();

    expect(completedUsages).toHaveLength(2);
    const firstTurnUsage = completedUsages.find((payload) => payload.turnId === firstTurnId);
    const secondTurnUsage = completedUsages.find((payload) => payload.turnId === secondTurnId);

    expect(firstTurnUsage?.usage).toBeUndefined();
    expect(secondTurnUsage?.usage).toBeUndefined();
  });
});
