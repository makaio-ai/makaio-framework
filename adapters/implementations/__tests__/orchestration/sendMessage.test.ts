import { describe, it, expect, afterEach } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  getAdapterUnderTest,
  getOrchestrationTestContext,
  resolveModelRef,
  updateMetaFromResponse,
  assertCompletedTurn,
  CONFORMANCE_SYSTEM_PROMPT,
} from '../shared.js';
import { AdapterSubjects, AgentSubjects } from '@makaio/contracts';

const adapterName = getAdapterUnderTest();
const ctx = await getOrchestrationTestContext(adapterName);
const config = ctx.testConfig;
const defaultTimeout = config.options?.defaultTimeout ?? 45_000;
const primaryModelRef = config.options?.primaryModel;

/**
 * Orchestration conformance tests for AdapterSubjects.sendMessage.
 *
 * These tests verify the full orchestration pipeline:
 * - MakaioBus.request() → adapter-initializer → SessionManager → Agent
 * - Event emissions through transformation layers
 * - Response structure and metadata
 *
 * Unlike agent-level tests, these go through the complete bus infrastructure.
 */
describe('Orchestration: sendMessage', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  it('sends one-shot message via AdapterSubjects.sendMessage', { timeout: defaultTimeout }, async ({ task }) => {
    cleanup = async () => {
      await ctx.adapter.closeAsync?.();
    };

    // Collect all events emitted for this adapter
    const events: Array<{ subject: string; payload: unknown }> = [];
    const unsubscribe = MakaioBus.__onAny((event) => {
      if (
        event.payload &&
        typeof event.payload === 'object' &&
        'adapterId' in event.payload &&
        event.payload.adapterId === ctx.adapterId
      ) {
        events.push({
          subject: event.subject,
          payload: event.payload,
        });
      }
    });

    try {
      // Start agent through full orchestration stack
      const response = await MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: ctx.adapterId,
        role: 'lead',
        initialMessage: 'Reply with the single word: OK',
        systemPrompt: CONFORMANCE_SYSTEM_PROMPT,
        ...resolveModelRef(primaryModelRef, ctx.testConfig.testProviderContext),
      });
      updateMetaFromResponse({ task }, response);

      // Verify response structure (no result field - startAgent doesn't block)
      expect(response).toMatchObject({
        agentId: expect.any(String),
        adapterId: ctx.adapterId,
        adapterSessionId: expect.any(String),
        messageId: expect.any(String),
      });

      expect(response.success).toBe(true);

      if (!response.success) throw new Error('startAgent failed');

      const completed = await MakaioBus.once(AgentSubjects.complete, {
        filter: { agentId: response.agentId },
      });

      // Verify core events were emitted
      console.debug(`\n[TEST] Events emitted (${events.length} total):`);
      events.forEach((event, idx) => {
        console.debug(`  ${idx + 1}. ${event.subject}`);
      });

      const eventSubjects = events.map((e) => e.subject);

      // adapter session lifecycle
      expect(eventSubjects).toContain('adapter.session.created');

      // Agent lifecycle (should see at least agent.started)
      const hasAgentStarted = eventSubjects.includes('agent.started');
      console.debug(`[TEST] agent.started emitted: ${hasAgentStarted}`);
      expect(hasAgentStarted).toBe(true);

      console.debug(`[TEST] Test completed successfully for ${adapterName}\n`);

      assertCompletedTurn(completed);
      expect(completed.payload.message.trim()).toBe('OK');
    } finally {
      unsubscribe();
    }
  });
});
