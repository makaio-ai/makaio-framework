import { describe, it, expect, afterEach } from 'vitest';
import type { TestModelRef } from '@makaio/ai-adapters-core';
import { MakaioBus } from '@makaio/bus-core';
import {
  getAdapterUnderTest,
  getAgentTestContext,
  getOrchestrationTestContext,
  resolveModelRef,
  updateMetaFromResponse,
  assertCompletedTurn,
  CONFORMANCE_SYSTEM_PROMPT,
} from '../shared.js';
import { AdapterSubjects, AgentSubjects, type SessionContext } from '@makaio/contracts';

type CleanupFn = () => Promise<void>;

interface RunTurnContextInput {
  adapterName: string;
  primaryModelRef?: TestModelRef;
  initialMessage: string;
  sessionContext: SessionContext;
  systemPrompt: string;
  timeoutMs: number;
}

const adapterName = getAdapterUnderTest();
const testConfig = (await getAgentTestContext(adapterName)).testConfig;
const adapterOptions = testConfig.options;
const primaryModelRef = adapterOptions?.primaryModel;
const completionTimeoutMs = adapterOptions?.defaultTimeout ?? 45_000;
const testTimeoutMs = completionTimeoutMs + 5_000;

/**
 * Starts an adapter agent and waits for completion.
 * @param adapterName - Adapter name under test
 * @param primaryModelRef - Optional model reference used to resolve model/provider for startAgent
 * @param initialMessage - User prompt to send as the first turn
 * @param sessionContext - Session context containing turnContext to materialize
 * @param systemPrompt - System prompt used for conformance runs
 * @param timeoutMs - Timeout for completion event waiting
 * @returns Start response, complete event payload wrapper, and cleanup function
 */
async function runAgentAndAwaitCompletion({
  adapterName,
  primaryModelRef,
  initialMessage,
  sessionContext,
  systemPrompt,
  timeoutMs,
}: RunTurnContextInput) {
  const ctx = await getOrchestrationTestContext(adapterName);
  const cleanup: CleanupFn = async () => {
    await ctx.adapter.close?.();
  };

  let completedSuccessfully = false;
  try {
    const response = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: ctx.adapterId,
      role: 'lead',
      ...resolveModelRef(primaryModelRef, ctx.testConfig.testProviderContext),
      initialMessage,
      sessionContext,
      systemPrompt,
    });

    if (!response.success) {
      throw new Error('startAgent failed');
    }

    const completed = await MakaioBus.once(AgentSubjects.complete, {
      filter: { agentId: response.agentId },
      timeoutMs,
    });

    completedSuccessfully = true;
    return { response, completed, cleanup };
  } finally {
    if (!completedSuccessfully) {
      await cleanup();
    }
  }
}

/**
 * Orchestration conformance tests for turnContext materialization.
 *
 * Verifies that ALL adapters correctly materialize sessionContext.turnContext
 * into the LLM-facing message, making turn-scoped context visible to the model.
 *
 * The adapter contract requires every adapter to call serializeTurnContext() and
 * prepend the resulting XML-tagged blocks to the user message before sending to
 * the LLM. These tests assert the end-to-end behaviour: the model must be able
 * to read and report values that were placed in turnContext.
 *
 * Tests go through the complete bus infrastructure:
 * - MakaioBus.request() → adapter-initializer → SessionManager → Agent → LLM
 */
// Note: Not using .concurrent because tests share cleanup variable — would cause race conditions
describe('Orchestration: turnContext materialization', () => {
  let cleanup: CleanupFn | undefined;

  afterEach(async () => {
    const toCleanup = cleanup;
    cleanup = undefined;
    await toCleanup?.();
  });

  it('LLM sees turnContext content in its prompt', { timeout: testTimeoutMs }, async ({ task }) => {
    // Unique marker so the test cannot pass by coincidence
    const testMarker = `TC-${Date.now().toString(36)}`;

    const run = await runAgentAndAwaitCompletion({
      adapterName,
      primaryModelRef,
      initialMessage: `What is the secret code in the <testMarker> block? Reply with ONLY the code, nothing else.`,
      sessionContext: {
        turnContext: {
          testMarker,
        },
      },
      systemPrompt: CONFORMANCE_SYSTEM_PROMPT,
      timeoutMs: completionTimeoutMs,
    });

    cleanup = run.cleanup;
    updateMetaFromResponse({ task }, run.response);

    assertCompletedTurn(run.completed);
    // LLM must echo back the marker it read from the materialized turnContext block
    expect(run.completed.payload.message).toContain(testMarker);
  });

  it('LLM sees active skills from turnContext', { timeout: testTimeoutMs }, async ({ task }) => {
    const run = await runAgentAndAwaitCompletion({
      adapterName,
      primaryModelRef,
      initialMessage: 'List the active skill names you see in your context. Reply with just the names, one per line.',
      sessionContext: {
        turnContext: {
          skills: [
            { name: 'brief-writing', content: 'Always be brief.' },
            { name: 'friendly-tone', content: 'Be friendly.' },
          ],
        },
      },
      systemPrompt: CONFORMANCE_SYSTEM_PROMPT,
      timeoutMs: completionTimeoutMs,
    });

    cleanup = run.cleanup;
    updateMetaFromResponse({ task }, run.response);

    assertCompletedTurn(run.completed);
    // LLM must report both skill names it read from the materialized skills block
    expect(run.completed.payload.message).toMatch(/brief-writing/i);
    expect(run.completed.payload.message).toMatch(/friendly-tone/i);
  });
});
