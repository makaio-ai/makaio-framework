import { describe, it, expect, beforeAll, vi } from 'vitest';
import { AIAgentConnector, AgentStartResult, normalizeMessageInput } from '@makaio/ai-adapters-core';
import { type AgentTestContext, getAdapterUnderTest, getAgentTestContext, updateMeta } from './shared.js';

const adapterName = getAdapterUnderTest();

describe.sequential('Queue & State Transitions', async () => {
  const adapterOptions = (await getAgentTestContext(adapterName)).testConfig.options;
  // Separate agent per scenario, since we're testing state mutations
  describe.sequential(
    'Enqueue Mode',
    () => {
      let context: AgentTestContext;
      let agent: AIAgentConnector;
      let startResult: AgentStartResult;
      const stateTransitions: string[] = [];

      beforeAll(async () => {
        const initialMessage = adapterName.includes('gemini')
          ? "Say the single word - don't use any tools: HI"
          : 'Say the single word: HI';
        context = await getAgentTestContext(adapterName, true, initialMessage);
        agent = context.agent;

        // Capture all state transitions
        agent.onProcessingStateChanged((state) => {
          stateTransitions.push(state);
        });

        startResult = await context.getAgentStartResult();
        startResult.messageHandle.waitForCompletion().then(() => {
          stateTransitions.push('message_completed');
        });
      });

      it('transitions through expected states', async () => {
        await context.getAgentStartResult();
        await agent.complete();

        // Fixed positions that are always the same
        const expectedTransitions =
          stateTransitions[0] === 'active' &&
          stateTransitions[1] === 'processing_started' &&
          stateTransitions[2] === 'turn_started';

        const lastTransition = stateTransitions[stateTransitions.length - 1];

        if (!expectedTransitions) {
          console.error('stateTransitions FAILED', stateTransitions);
        }
        if (lastTransition !== 'idle') {
          console.error('lastTransition FAILED', lastTransition);
        }

        expect(expectedTransitions).toBe(true);

        expect(lastTransition).toBe('idle');

        // Must contain these states
        expect(stateTransitions).toContain('step_started');
        expect(stateTransitions).toContain('step_finished');
        expect(stateTransitions).toContain('message_completed');

        // Ordering constraints
        const messageCompletedIdx = stateTransitions.indexOf('message_completed');
        const turnFinishedIdx = stateTransitions.lastIndexOf('turn_finished');
        const processingFinishedIdx = stateTransitions.lastIndexOf('processing_finished');

        console.debug('State Transitions:', stateTransitions);

        // Both message_completed and turn_finished must come before processing_finished
        expect(messageCompletedIdx).toBeLessThan(processingFinishedIdx);
        expect(turnFinishedIdx).toBeLessThan(processingFinishedIdx);

        // processing_finished must come before idle (already checked above)
        expect(processingFinishedIdx).toBe(stateTransitions.length - 2);
      });

      it('returns correct result for initial message', async () => {
        const initialResult = await context.getAgentStartResult();

        await expect(initialResult.messageHandle.waitForCompletion()).resolves.toMatchObject({
          outcome: 'completed',
          result: {
            message: expect.stringMatching(/^\s*hi\s*$/gi),
          },
        });
      });

      it('processes enqueued message after initial completes', async ({ task }) => {
        // Agent is already started and idle from previous test
        const handle = await agent.sendMessage(normalizeMessageInput('Say the single word: HELLO'), {
          deliveryMode: 'enqueue',
        });
        expect(handle.adapterSessionId).toBeDefined();
        updateMeta({ task }, 'adapterSessionId', handle.adapterSessionId!);

        // Verify initial message result is still valid (already completed, no polling needed)
        const initialResult = await context.getAgentStartResult();
        await expect(initialResult.messageHandle.waitForCompletion()).resolves.toMatchObject({
          outcome: 'completed',
          result: {
            message: expect.stringMatching(/^\s*hi\s*$/gi),
          },
        });

        const result = await handle.waitForCompletion();
        await agent.complete();

        expect(result.outcome).toBe('completed');
        expect(result.result?.message).toMatch(/^\s*hello\s*$/gi);
        expect(agent.getProcessingState()).toBe('idle');
      });
    },
    adapterOptions?.defaultTimeout ?? 60_000,
  );

  describe('Replace Mode', () => {
    it(
      'supersedes all unacknowledged messages',
      async ({ task }) => {
        const context = await getAgentTestContext(adapterName);
        const agent = context.agent;
        updateMeta({ task }, 'agentId', agent.getAgentId());

        // Start agent and wait for it to be processing
        const startResult = await agent.start(normalizeMessageInput('Say "Sheep sleep deep" three times fast!'), {
          systemPrompt: context.conformanceSystemPrompt,
        });
        updateMeta({ task }, 'agentId', startResult.agentId);
        updateMeta({ task }, 'adapterSessionId', startResult.adapterSessionId);

        await startResult.messageHandle.waitForAcknowledgment();

        // Queue messages while agent is busy - they won't be acknowledged yet
        const handle1 = await agent.sendMessage(normalizeMessageInput('Say the single word: HI'), {
          deliveryMode: 'enqueue',
        });

        expect(handle1.adapterSessionId).toBeDefined();
        updateMeta({ task }, 'adapterSessionId', handle1.adapterSessionId!);

        const handle2 = await agent.sendMessage(normalizeMessageInput('Say the single word: HELLO'), {
          deliveryMode: 'enqueue',
        });
        expect(handle2.adapterSessionId).toBeDefined();
        updateMeta({ task }, 'adapterSessionId', handle2.adapterSessionId!);

        const replaceHandle = await agent.sendMessage(normalizeMessageInput('Say the single word: OK'), {
          deliveryMode: 'replace',
        });
        expect(replaceHandle.adapterSessionId).toBeDefined();
        updateMeta({ task }, 'adapterSessionId', replaceHandle.adapterSessionId!);

        // Wait for each handle with individual timeout to identify which one hangs
        const [initialResult, result1, result2, result3] = await Promise.all([
          vi.waitFor(() => startResult.messageHandle.waitForCompletion(), {
            timeout: adapterOptions?.defaultTimeout ?? 10_000,
          }),
          vi.waitFor(() => handle1.waitForCompletion(), { timeout: adapterOptions?.defaultTimeout ?? 10_000 }),
          vi.waitFor(() => handle2.waitForCompletion(), { timeout: adapterOptions?.defaultTimeout ?? 10_000 }),
          vi.waitFor(() => replaceHandle.waitForCompletion(), { timeout: adapterOptions?.defaultTimeout ?? 10_000 }),
        ]);
        await agent.complete();

        const resultMessage = result3.result?.message?.toLowerCase()?.trim();

        expect(initialResult.outcome).toBe('completed');
        expect(result1.outcome).toBe('superseded');
        expect(result2.outcome).toBe('superseded');
        expect(result3.outcome).toBe('completed');
        expect(resultMessage).toMatch(/^ok\b/);
        expect(agent.getProcessingState()).toBe('idle');
      },
      adapterOptions?.defaultTimeout ?? 60_000,
    );

    it(
      'preserves acknowledged message, supersedes queued',
      async ({ task }) => {
        const context = await getAgentTestContext(adapterName, false);
        const agent = context.agent;
        updateMeta({ task }, 'agentId', agent.getAgentId());
        updateMeta({ task }, 'adapterId', agent.adapterId);

        // Prime the agent so queue is ready
        const primeResult = await context.getAgentStartResult();
        updateMeta({ task }, 'adapterSessionId', primeResult.adapterSessionId);

        await agent.complete();

        const handle1 = await agent.sendMessage(normalizeMessageInput('Say the single word: HI'), {
          deliveryMode: 'enqueue',
        });
        await handle1.waitForAcknowledgment();
        updateMeta({ task }, 'adapterSessionId', handle1.adapterSessionId!);

        const handle2 = await agent.sendMessage(normalizeMessageInput('Say the single word: HELLO'), {
          deliveryMode: 'enqueue',
        });
        updateMeta({ task }, 'adapterSessionId', handle2.adapterSessionId!);

        const replaceHandle = await agent.sendMessage(normalizeMessageInput('Say the single word: OK'), {
          deliveryMode: 'replace',
        });
        updateMeta({ task }, 'adapterSessionId', replaceHandle.adapterSessionId!);

        const [result1, result2, result3] = await Promise.all([
          handle1.waitForCompletion(),
          handle2.waitForCompletion(),
          replaceHandle.waitForCompletion(),
        ]);
        await agent.complete();

        const resultMessage = result3.result?.message?.toLowerCase()?.trim();

        expect(result1.outcome).toBe('completed');
        expect(result2.outcome).toBe('superseded');
        expect(result3.outcome).toBe('completed');
        expect(resultMessage).toMatch(/^ok\b/);
        expect(agent.getProcessingState()).toBe('idle');
      },
      adapterOptions?.defaultTimeout ?? 60_000,
    );
  });
});
