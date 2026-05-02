import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type AgentStartResult, MessageHandle } from '@makaio/ai-adapters-core';
import { getAdapterUnderTest, getAgentTestContext, updateMeta } from './shared.js';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';

const adapterName = getAdapterUnderTest();

describe('Simple Tests', { concurrent: true, timeout: 30_000 }, async () => {
  const testContext = await getAgentTestContext(adapterName, true);
  const config = testContext.testConfig;
  const defaultTimeout = config.options?.defaultTimeout ?? 45_000;

  describe.concurrent(
    'Initialization',
    () => {
      it(`should load adapter`, async ({ task }) => {
        updateMeta({ task }, 'agentId', testContext.agentId);
        updateMeta({ task }, 'adapterId', testContext.adapterId);
        expect(testContext.adapterImport).toBeDefined();
      });

      it('should start a session', async ({ task }) => {
        updateMeta({ task }, 'agentId', testContext.agentId);
        updateMeta({ task }, 'adapterId', testContext.adapterId);
        const startResult = await testContext.getAgentStartResult();
        updateMeta({ task }, 'adapterSessionId', startResult.adapterSessionId);
        expect(startResult).toBeDefined();
        expect(startResult.adapterSessionId).toBeDefined();
        expect(startResult.messageHandle).toBeDefined();
      });
    },
    defaultTimeout,
  );

  describe.concurrent(
    'Progress Change Flow',
    async () => {
      let startResult: AgentStartResult;
      let firstMessageHandle: MessageHandle;

      beforeAll(async () => {
        startResult = await testContext.getAgentStartResult();
        firstMessageHandle = startResult.messageHandle;
      });

      it('should transition to idle after completion', async ({ task }) => {
        updateMeta({ task }, 'agentId', startResult.agentId);
        updateMeta({ task }, 'adapterSessionId', startResult.adapterSessionId);
        await firstMessageHandle.waitForCompletion();
        await new Promise<void>((resolve) => setTimeout(() => resolve(), 1000)); // Give some time for state to update
        expect(testContext.agent.getProcessingState()).toBe('idle');
      });

      it('should complete processing successfully', async ({ task }) => {
        updateMeta({ task }, 'agentId', startResult.agentId);
        updateMeta({ task }, 'adapterSessionId', startResult.adapterSessionId);
        const result = await firstMessageHandle.waitForCompletion();
        expect(result.outcome).toBe('completed');
      });
    },
    defaultTimeout,
  );

  describe(
    'Initial Prompt',
    async () => {
      let startResult: AgentStartResult;
      let firstMessageHandle: MessageHandle;
      let unsub: () => void;

      beforeAll(async () => {
        startResult = await testContext.getAgentStartResult();
        firstMessageHandle = startResult.messageHandle;
        unsub = MakaioBus.on(AgentSubjects.toolApprove, (context) => {
          context.setResult({
            action: 'deny',
            message: "Please don't use tools, the prompt is simple.",
          });
        });
      });

      afterAll(() => {
        unsub?.();
      });

      it('should complete a simple message with correct result', async () => {
        const completion = await firstMessageHandle.waitForCompletion();
        expect(completion.outcome).toBe('completed');
        expect(completion.result).toBeDefined();
        expect(completion.result?.message?.trim()).toBe('OK');
      });
    },
    defaultTimeout,
  );
});
