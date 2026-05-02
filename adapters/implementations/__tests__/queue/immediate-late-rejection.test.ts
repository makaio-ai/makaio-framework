import { describe, it, expect, beforeAll, vi } from 'vitest';
import { type AIAgentConnector, normalizeMessageInput } from '@makaio/ai-adapters-core';
import { type AgentTestContext, getAdapterUnderTest, getAgentTestContext, updateMeta } from '../shared.js';

const adapterName = getAdapterUnderTest();

/**
 * Test Branch: Simple Late Rejection
 *
 * Flow: initial (processing) → enqueued → immediate (arrives too late)
 *
 * Expected behavior:
 * - Initial message completes normally
 * - Enqueued message processes normally (immediate was rejected, doesn't supersede)
 * - Immediate message is REJECTED (arrived after turn finished - too late for context injection)
 * - Agent ends in idle or paused state
 */
describe('Immediate Mode: Late Rejection', { timeout: 60_000 }, async () => {
  describe(`${adapterName} adapter`, () => {
    let context: Awaited<AgentTestContext>;
    let agent: AIAgentConnector;

    beforeAll(async () => {
      context = await getAgentTestContext(adapterName, true);
      agent = context.agent;
      await context.getAgentStartResult();
    });

    it('rejects immediate message that arrives after turn finishes', async ({ task }) => {
      // Start with simple/fast initial message
      const startResult = await context.getAgentStartResult();
      updateMeta({ task }, 'adapterSessionId', startResult.adapterSessionId);

      await agent.onceProcessingStateChanged((state) => state === 'turn_finished');

      // Send immediate - but by the time it's ready, initial will have finished
      // (Simple math prompt is fast, so immediate arrives "too late")
      const immediateHandle = await agent.sendMessage(
        normalizeMessageInput('STOP. Additional context: the answer should be in binary.'),
        { deliveryMode: 'immediate', messageId: '22222222-2222-2222-2222-222222222222' },
      );
      updateMeta({ task }, 'adapterSessionId', immediateHandle.adapterSessionId!);

      // Wait for all to complete
      const [initialResult, immediateResult] = await Promise.all([
        vi.waitFor(async () => startResult.messageHandle.waitForCompletion(), { timeout: 15_000 }),
        vi.waitFor(async () => immediateHandle.waitForCompletion(), { timeout: 15_000 }),
      ]);

      if (initialResult.outcome !== 'completed') {
        console.error('Initial result error:', initialResult);
      }

      // Assertions
      expect(initialResult.outcome).toBe('completed');
      expect(initialResult.result?.message?.trim()).toBe('OK');

      // Immediate should be rejected (too late)
      expect(immediateResult.outcome).toBe('rejected');
      expect(immediateResult.result?.message?.trim()).not.toBe('OK');

      await agent.complete();

      // Agent might be paused (after rejection) or idle
      expect(['idle', 'paused']).toContain(agent.getProcessingState());
    });

    it('rejects multiple late immediate messages', async ({ task }) => {
      // Start fresh agent
      const freshContext = await getAgentTestContext(adapterName, false);
      const freshAgent = freshContext.agent;
      updateMeta({ task }, 'agentId', freshAgent.getAgentId());
      updateMeta({ task }, 'adapterId', freshAgent.adapterId);

      const awaitedTurnFinished = freshAgent.onceProcessingStateChanged((state) => state === 'turn_finished');

      const startResult = await freshContext.getAgentStartResult();
      updateMeta({ task }, 'adapterSessionId', startResult.adapterSessionId);
      const timeout = freshContext.testConfig.options?.defaultTimeout ?? 15_000;

      await vi.waitFor(async () => awaitedTurnFinished, {
        timeout,
      });

      // Send two immediate messages (both will arrive too late)
      const immediate1 = await freshAgent.sendMessage(normalizeMessageInput('Context 1'), {
        deliveryMode: 'immediate',
      });
      updateMeta({ task }, 'adapterSessionId', immediate1.adapterSessionId!);

      const immediate2 = await freshAgent.sendMessage(normalizeMessageInput('Context 2'), {
        deliveryMode: 'immediate',
      });
      updateMeta({ task }, 'adapterSessionId', immediate2.adapterSessionId!);

      await Promise.all([
        vi.waitFor(
          async () =>
            expect(startResult.messageHandle.waitForCompletion()).resolves.toMatchObject({
              outcome: 'completed',
              result: {
                message: expect.stringContaining('OK'),
              },
            }),
          { timeout: 15_000 },
        ),
        vi.waitFor(
          async () =>
            expect(immediate1.waitForCompletion()).resolves.toMatchObject({
              outcome: 'rejected',
            }),
          { timeout: 15_000 },
        ),
        vi.waitFor(
          async () =>
            expect(immediate2.waitForCompletion()).resolves.toMatchObject({
              outcome: 'rejected',
            }),
          { timeout: 15_000 },
        ),
      ]);
    });
  });
});
