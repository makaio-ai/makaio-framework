import { describe, it, expect, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  getAdapterUnderTest,
  getAgentTestContext,
  getOrchestrationTestContext,
  resolveModelRef,
  updateMetaFromResponse,
  assertCompletedTurn,
} from '../shared.js';
import { AdapterSubjects, AgentSubjects } from '@makaio/contracts';

const now = Date.now();
const adapterName = getAdapterUnderTest();

/**
 * Orchestration conformance tests for conversation continuation via sessionContext.
 *
 * Tests verify that adapters correctly handle injected message history,
 * allowing LLMs to recall information from previous turns in stateless mode.
 *
 * History is passed via sessionContext.messageHistory with isFirstTurn: true
 * to signal that no native history exists and injection is required.
 *
 * These tests go through the complete bus infrastructure:
 * - MakaioBus.request() → adapter-initializer → SessionManager → Agent
 */
// Note: Not using .concurrent because tests share cleanup variable - would cause race conditions
describe('Orchestration: continuation', async () => {
  let cleanup: (() => Promise<void>) | undefined;
  const testConfig = (await getAgentTestContext(adapterName)).testConfig;
  const adapterOptions = testConfig.options;
  const primaryModelRef = adapterOptions?.primaryModel;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  it(
    'LLM recalls information from injected messageHistory',
    { timeout: adapterOptions?.defaultTimeout ?? 30_000 },
    async (context) => {
      const ctx = await getOrchestrationTestContext(adapterName);
      cleanup = async () => await ctx.adapter.close?.();

      let systemPrompt = 'You are naturally continuing a conversation with user.';

      if (adapterName.includes('gemini')) {
        systemPrompt += ' Do not use any tools.';
      }

      // Start agent with sessionContext containing prior context
      const response = await MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: ctx.adapterId,
        role: 'lead',
        ...resolveModelRef(primaryModelRef, ctx.testConfig.testProviderContext),
        initialMessage: 'My favorite color is blue. What is my name?',
        sessionContext: {
          messageHistory: [
            {
              role: 'user',
              blocks: [
                {
                  type: 'text',
                  content: `Current timestamp is ${now}`,
                },
              ],
            },
            { role: 'user', blocks: [{ type: 'text', content: 'My name is Alice. Reply with OK.' }] },
            { role: 'assistant', blocks: [{ type: 'text', content: 'OK' }] },
          ],
          isFirstTurn: true, // No native history exists, injection required
        },
        systemPrompt,
      });
      updateMetaFromResponse(context, response);

      expect(response.success).toBe(true);
      if (!response.success) throw new Error('startAgent failed');

      const completed = await MakaioBus.once(AgentSubjects.complete, {
        filter: { agentId: response.agentId },
        timeoutMs: adapterOptions?.defaultTimeout ?? 45_000,
      });

      assertCompletedTurn(completed);
      // LLM should recall "Alice" from the injected history
      expect(completed.payload.message).toContain('Alice');
    },
  );

  it(
    'LLM recalls multiple facts from messageHistory',
    { timeout: adapterOptions?.defaultTimeout ?? 30_000, retry: adapterName.includes('openai') ? 3 : 1 },
    async (context) => {
      const ctx = await getOrchestrationTestContext(adapterName);
      cleanup = async () => await ctx.adapter.close?.();

      let systemPrompt = 'You are naturally continuing a conversation with user.';

      if (adapterName.includes('gemini')) {
        systemPrompt += ' Do not use any tools.';
      }

      // Start agent with sessionContext containing multiple facts
      const response = await MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: ctx.adapterId,
        role: 'lead',
        ...resolveModelRef(primaryModelRef, ctx.testConfig.testProviderContext),
        initialMessage: 'What is my name and favorite color?',
        sessionContext: {
          messageHistory: [
            {
              role: 'user',
              blocks: [
                {
                  type: 'text',
                  content: `Current timestamp is ${now}`,
                },
              ],
            },
            { role: 'user', blocks: [{ type: 'text', content: 'My name is Alice. Reply with OK.' }] },
            { role: 'assistant', blocks: [{ type: 'text', content: 'OK' }] },
            {
              role: 'user',
              blocks: [
                {
                  type: 'text',
                  content: 'My favorite color is blue. Reply with OK.',
                },
              ],
            },
            { role: 'assistant', blocks: [{ type: 'text', content: 'OK' }] },
          ],
          isFirstTurn: true, // No native history exists, injection required
        },
        systemPrompt,
      });
      updateMetaFromResponse(context, response);

      expect(response.success).toBe(true);
      if (!response.success) throw new Error('startAgent failed');

      const completed = await MakaioBus.once(AgentSubjects.complete, {
        filter: { agentId: response.agentId },
        timeoutMs: adapterOptions?.defaultTimeout ?? 45_000,
      });

      assertCompletedTurn(completed);
      // LLM should recall both facts from the injected history
      expect(completed.payload.message).toContain('Alice');
      expect(completed.payload.message.toLowerCase()).toContain('blue');
    },
  );
});
