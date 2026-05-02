import { describe, it, expect } from 'vitest';
import { normalizeMessageInput } from '@makaio/ai-adapters-core';
import { getAdapterUnderTest, getAgentTestContext, updateMeta } from '../shared.js';

const adapterName = getAdapterUnderTest();

/**
 * Test Branch: Immediate Merges Multiple Enqueued
 *
 * Flow: initial (processing) → enqueued1 → enqueued2 → immediate (arrives on time)
 *
 * Expected behavior:
 * - Initial message is SUPERSEDED (in-flight, taken over by immediate)
 * - ALL enqueued messages (msg1, msg2) are MERGED into immediate
 *   (queued content combined, not superseded - they were never in-flight)
 * - Immediate message is delivered in same turn as initial
 * - Agent ends in idle state
 */
describe('Immediate Mode: Supersedes Multiple Enqueued', async () => {
  const adapterOptions = (await getAgentTestContext(adapterName)).testConfig.options;

  describe(`${adapterName} adapter`, { timeout: adapterOptions?.defaultTimeout ?? 60_000 }, async () => {
    const context = await getAgentTestContext(adapterName, false);

    it('supersedes and merges all enqueued messages when immediate arrives', async ({ task }) => {
      const agent = context.agent;
      updateMeta({ task }, 'agentId', agent.getAgentId());
      updateMeta({ task }, 'adapterId', agent.adapterId);

      const prompt = 'Peter gave me 5 apples.';
      const startResult = await agent.start(normalizeMessageInput(prompt), {
        systemPrompt: context.conformanceSystemPrompt,
      });
      updateMeta({ task }, 'adapterSessionId', startResult.adapterSessionId);

      await startResult.messageHandle.waitForAcknowledgment();

      // Enqueue two messages while initial is processing
      const enqueued1 = await agent.sendMessage(normalizeMessageInput('Alice gave me 3 apples.'), {
        deliveryMode: 'enqueue',
      });
      updateMeta({ task }, 'adapterSessionId', enqueued1.adapterSessionId!);

      const enqueued2 = await agent.sendMessage(normalizeMessageInput('Bob gave me 4 apples.'), {
        deliveryMode: 'enqueue',
      });
      updateMeta({ task }, 'adapterSessionId', enqueued2.adapterSessionId!);

      // Immediate arrives - should merge all messages and provide the sum
      const immediateHandle = await agent.sendMessage(
        normalizeMessageInput(
          'Calculate the total: How many apples did Peter, Alice, and Bob give me in total? ' +
            'Respond with ONLY the number as your answer.',
        ),
        {
          deliveryMode: 'immediate',
        },
      );
      updateMeta({ task }, 'adapterSessionId', immediateHandle.adapterSessionId!);

      // Wait for all
      const [initialResult, enqueued1Result, enqueued2Result, immediateResult] = await Promise.all([
        startResult.messageHandle.waitForCompletion(),
        enqueued1.waitForCompletion(),
        enqueued2.waitForCompletion(),
        immediateHandle.waitForCompletion(),
      ]);

      console.debug('immediateResult:', JSON.stringify(immediateResult, null, 2));

      // Immediate completes
      expect(immediateResult.outcome).toBe('completed');
      expect(immediateResult.result?.message?.trim()).toContain('12');

      // Initial superseded
      expect(initialResult.outcome).toBe('superseded');

      // Both enqueued are merged (queued messages get merged, not superseded)
      // Note: 'superseded' = in-flight message taken over; 'merged' = queued content combined
      expect(enqueued1Result.outcome).toBe('merged');
      expect(enqueued2Result.outcome).toBe('merged');

      await agent.complete();
      expect(agent.getProcessingState()).toBe('idle');
    });
  });
});
