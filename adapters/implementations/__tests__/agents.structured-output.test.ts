import { describe, it, expect } from 'vitest';
import { normalizeMessageInput, type AgentStartResult } from '@makaio/ai-adapters-core';
import type { ResponseSchemaDescriptor } from '@makaio/contracts';
import { getAdapterUnderTest, getAgentTestContext, updateMeta } from './shared.js';

const adapterName = getAdapterUnderTest();

const nativeStructuredOutputAdapters = new Set([
  'anthropic-sdk',
  'claude-agent-sdk',
  'claude-code-cli',
  'codex-app-server',
  'openai-node',
]);
const describeIfNativeStructuredOutput = nativeStructuredOutputAdapters.has(adapterName) ? describe : describe.skip;

type StructuredOutputPayload = {
  status?: unknown;
  answer?: unknown;
};

const responseSchema = {
  name: 'structured_output_conformance',
  schema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ok'] },
      answer: { type: 'string' },
    },
    required: ['status', 'answer'],
    additionalProperties: false,
  },
} satisfies ResponseSchemaDescriptor;

function parseStructuredOutput(message: string | undefined): StructuredOutputPayload {
  expect(message).toEqual(expect.any(String));
  return JSON.parse(message ?? '') as StructuredOutputPayload;
}

describeIfNativeStructuredOutput('Structured Output', async () => {
  const testContext = await getAgentTestContext(adapterName);
  const defaultTimeout = Math.max(testContext.testConfig.options?.defaultTimeout ?? 45_000, 120_000);

  it(
    'returns JSON matching responseSchema for adapters with native structured output',
    async ({ task }) => {
      const agent = await testContext.createConnector({ reasoningEffort: 'none' });
      let startResult: AgentStartResult | undefined;
      try {
        updateMeta({ task }, 'agentId', agent.getAgentId());
        updateMeta({ task }, 'adapterId', agent.adapterId);

        startResult = await agent.start(
          normalizeMessageInput('Return exactly this JSON object: {"status":"ok","answer":"blue"}'),
          {
            systemPrompt: testContext.conformanceSystemPrompt,
            responseSchema,
          },
        );
        updateMeta({ task }, 'agentId', startResult.agentId);
        updateMeta({ task }, 'adapterSessionId', startResult.adapterSessionId);

        const completion = await startResult.messageHandle.waitForCompletion();
        await agent.complete();

        expect(completion.outcome).toBe('completed');
        const payload = parseStructuredOutput(completion.result?.message);
        expect(payload).toEqual({
          status: 'ok',
          answer: 'blue',
        });
      } finally {
        await agent.close();
      }
    },
    defaultTimeout,
  );
});
