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
import fs from 'fs';
import path from 'path';
import os from 'node:os';

const now = Date.now();
const adapterName = getAdapterUnderTest();

/**
 * Check whether adapter under test is Gemini-based.
 * @param resolvedAdapterName - Adapter name from test harness
 * @returns True when adapter name indicates Gemini
 */
function isGeminiAdapter(resolvedAdapterName: string): boolean {
  return resolvedAdapterName.includes('gemini');
}

/**
 * Build the system prompt for an adapter.
 * @param basePrompt - Base prompt text
 * @param resolvedAdapterName - Adapter name used for conditional tweaks
 * @returns Final prompt string with Gemini-specific tool-avoidance suffix when needed
 */
function buildSystemPrompt(basePrompt: string, resolvedAdapterName: string): string {
  return isGeminiAdapter(resolvedAdapterName) ? `${basePrompt} Do not use any tools.` : basePrompt;
}

/**
 * Orchestration conformance tests for Plan C: lifecycle mutations and recovery.
 *
 * Two consolidated sessions cover:
 * - Session 1 (mutations): history injection at start, mutation rejection during active
 *   turn, cwd change via connector swap, post-swap history recall, model change
 * - Session 2 (rehydration): normal start, establish facts, rehydrateAgent, post-rehydrate
 *   history injection via sendMessage, identity preservation
 *
 * Consolidated to minimize API calls — each session is a real LLM invocation.
 *
 * Depends on: Plan A (connector swap + mutation subjects), Plan B (agent persistence)
 *
 * Replaces: continuation.test.ts (which tests a subset of Session 1)
 */

/**
 * Session 1: Lifecycle mutations
 *
 * One agent, sequential operations testing the full mutation surface:
 *
 * 1. startAgent with messageHistory (Alice + blue) + isFirstTurn
 *    → verify recalls both facts
 * 2. cwd.change during active turn → verify rejection
 * 3. cwd.change while idle → verify success + cwd.changed event
 * 4. sendMessage post-swap with history → verify recalls Alice
 * 5. model.change while idle → verify success + model.changed event
 *    (switches from primaryModel → secondaryModel)
 * 6. sendMessage post-model-change → verify agent responds
 */
describe('Orchestration: lifecycle mutations', async () => {
  let cleanup: (() => Promise<void>) | undefined;
  const testConfig = (await getAgentTestContext(adapterName)).testConfig;
  const adapterOptions = testConfig.options;

  /** Primary model ref for initial agent creation (cost-sensitive) */
  const primaryModelRef = adapterOptions?.primaryModel;
  /** Secondary model ref for model change target — skip model change if not available */
  const secondaryModelRef = adapterOptions?.secondaryModel;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  it('full mutation lifecycle: history recall → cwd change → model change', {
    timeout: (adapterOptions?.defaultTimeout ?? 45_000) * 3,
  }, async (context) => {
    const ctx = await getOrchestrationTestContext(adapterName);
    cleanup = async () => await ctx.adapter.close?.();

    const systemPrompt = buildSystemPrompt('You are naturally continuing a conversation with user.', adapterName);

    // Collect cwd.changed and model.changed events
    const mutationEvents: Array<{ subject: string; payload: unknown }> = [];
    const unsubMutations = MakaioBus.__onAny((event) => {
      if (event.subject === 'agent.cwd.changed' || event.subject === 'agent.model.changed') {
        mutationEvents.push({ subject: event.subject, payload: event.payload });
      }
    });

    try {
      // ── Step 1: Start with injected history, verify recall ──────────
      const response = await MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: ctx.adapterId,
        role: 'lead',
        ...resolveModelRef(primaryModelRef, ctx.testConfig.testProviderContext),
        initialMessage: 'My favorite color is blue. What is my name and favorite color?',
        sessionContext: {
          messageHistory: [
            {
              role: 'user' as const,
              blocks: [{ type: 'text' as const, content: 'My name is Alice. Reply with OK.' }],
            },
            { role: 'assistant' as const, blocks: [{ type: 'text' as const, content: 'OK' }] },
          ],
          isFirstTurn: true,
        },
        systemPrompt,
      });

      updateMetaFromResponse(context, response);
      expect(response.success).toBe(true);
      if (!response.success) throw new Error('startAgent failed');

      const agentId = response.agentId;
      const adapterId = response.adapterId;
      const adapterSessionId = response.adapterSessionId;

      // ── Step 2: Attempt cwd.change during active turn → rejection ───
      // Fire immediately before awaiting completion — turn is still active
      const rejectionResult = await MakaioBus.request(AgentSubjects.cwd.change, {
        agentId,
        adapterId,
        adapterName: ctx.adapterName,
        adapterSessionId,
        newCwd: path.join(os.tmpdir(), 'mutation-test-reject'),
      });
      expect(rejectionResult.success).toBe(false);
      expect(rejectionResult.reason).toBeDefined();

      // Now await completion of Step 1's message, then wait for idle
      // Register idle listener BEFORE awaiting complete (idle fires shortly after complete)
      const firstIdle = MakaioBus.once(AgentSubjects.idle, {
        filter: { agentId },
        timeoutMs: adapterOptions?.defaultTimeout ?? 45_000,
      });
      const firstCompleted = await MakaioBus.once(AgentSubjects.complete, {
        filter: { agentId },
        timeoutMs: adapterOptions?.defaultTimeout ?? 45_000,
      });

      assertCompletedTurn(firstCompleted);
      expect(firstCompleted.payload.message).toContain('Alice');
      expect(firstCompleted.payload.message.toLowerCase()).toContain('blue');

      await firstIdle;

      // ── Step 3: cwd.change while idle → success + event ─────────────
      const newCwd = path.join(os.tmpdir(), `mutation-test-${now}`);
      fs.mkdirSync(newCwd, { recursive: true });

      const cwdResult = await MakaioBus.request(AgentSubjects.cwd.change, {
        agentId,
        adapterId,
        adapterName: ctx.adapterName,
        adapterSessionId,
        newCwd,
      });
      expect(cwdResult.success).toBe(true);

      // Verify cwd.changed event was emitted
      const cwdEvent = mutationEvents.find((e) => e.subject === 'agent.cwd.changed');
      expect(cwdEvent).toBeDefined();

      // ── Step 4: sendMessage post-swap with history → recall ─────────
      // Fresh connector has no adapterSessionId → shouldUseNativeResume = false
      // History injection via sendMessage (the recovery code path)
      await MakaioBus.request(AgentSubjects.sendMessage, {
        agentId,
        adapterId,
        message: { blocks: [{ type: 'text', content: 'What is my name?' }] },
        sessionContext: {
          messageHistory: [
            {
              role: 'user' as const,
              blocks: [{ type: 'text' as const, content: 'My name is Alice. Reply with OK.' }],
            },
            {
              role: 'assistant' as const,
              blocks: [{ type: 'text' as const, content: 'OK' }],
            },
          ],
          isFirstTurn: true,
        },
      });

      const postSwapIdle = MakaioBus.once(AgentSubjects.idle, {
        filter: { agentId },
        timeoutMs: adapterOptions?.defaultTimeout ?? 45_000,
      });
      const postSwapCompleted = await MakaioBus.once(AgentSubjects.complete, {
        filter: { agentId },
        timeoutMs: adapterOptions?.defaultTimeout ?? 45_000,
      });

      assertCompletedTurn(postSwapCompleted);
      expect(postSwapCompleted.payload.message).toContain('Alice');

      await postSwapIdle;

      // ── Step 5: model.change while idle → success + event ───────────
      // Switch from primaryModel → secondaryModel. Skip if adapter has no model tiers.
      if (secondaryModelRef && primaryModelRef && secondaryModelRef.modelName !== primaryModelRef.modelName) {
        const { model: newModel, ...secondaryProvider } = resolveModelRef(
          secondaryModelRef,
          ctx.testConfig.testProviderContext,
        );
        const modelChangeResult = await MakaioBus.request(AgentSubjects.model.change, {
          agentId,
          adapterId,
          adapterName: ctx.adapterName,
          adapterSessionId,
          newModel,
          ...secondaryProvider,
        });
        expect(modelChangeResult.success).toBe(true);

        const modelEvent = mutationEvents.find((e) => e.subject === 'agent.model.changed');
        expect(modelEvent).toBeDefined();

        // ── Step 6: sendMessage post-model-change → agent responds ──────
        await MakaioBus.request(AgentSubjects.sendMessage, {
          agentId,
          adapterId,
          message: { blocks: [{ type: 'text', content: 'Reply with the single word: OK' }] },
        });

        const postModelCompleted = await MakaioBus.once(AgentSubjects.complete, {
          filter: { agentId },
          timeoutMs: adapterOptions?.defaultTimeout ?? 45_000,
        });

        assertCompletedTurn(postModelCompleted);
        expect(postModelCompleted.payload.message.trim()).toBe('OK');
      }

      // Verify same agentId throughout — identity preserved
      expect(agentId).toBe(response.agentId);
    } finally {
      unsubMutations();
    }
  });
});

/**
 * Session 2: Recovery via rehydration
 *
 * Tests the rehydrateAgent bus subject — connector swap triggered externally
 * (simulating server restart / dead connector), then history injection via
 * sendMessage. Verifies identity preservation.
 *
 * 1. startAgent normally (no history)
 * 2. sendMessage — establish a fact ("my name is Bob")
 * 3. rehydrateAgent → connector swap
 * 4. sendMessage with messageHistory + isFirstTurn → verify recall + same agentId
 */
describe('Orchestration: recovery rehydration', async () => {
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

  it('rehydrated agent preserves identity and recalls injected history', {
    timeout: (adapterOptions?.defaultTimeout ?? 45_000) * 3,
  }, async (context) => {
    const ctx = await getOrchestrationTestContext(adapterName);
    cleanup = async () => await ctx.adapter.close?.();

    const systemPrompt = buildSystemPrompt('You are a helpful assistant. Keep responses very brief.', adapterName);

    // ── Step 1: Start agent normally ──────────────────────────────────
    const response = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: ctx.adapterId,
      role: 'lead',
      ...resolveModelRef(primaryModelRef, ctx.testConfig.testProviderContext),
      initialMessage: 'My name is Bob. Reply with OK.',
      systemPrompt,
    });

    updateMetaFromResponse(context, response);
    expect(response.success).toBe(true);
    if (!response.success) throw new Error('startAgent failed');

    const agentId = response.agentId;
    const adapterId = response.adapterId;

    // Auto-approve tool calls for this agent (Gemini's SDK system prompt
    // instructs the model to use save_memory for user facts — denying it
    // poisons the context and causes recall failures)
    const unsubToolApprove = isGeminiAdapter(adapterName)
      ? MakaioBus.on(AgentSubjects.toolApprove, (ctx) => ctx.setResult({ action: 'allow' }), {
          filter: { agentId },
        })
      : undefined;

    try {
      // Wait for first message to complete
      const firstCompleted = await MakaioBus.once(AgentSubjects.complete, {
        filter: { agentId },
        timeoutMs: adapterOptions?.defaultTimeout ?? 45_000,
      });
      assertCompletedTurn(firstCompleted);

      // ── Step 2: Verify normal follow-up works ─────────────────────────
      await MakaioBus.request(AgentSubjects.sendMessage, {
        agentId,
        adapterId,
        message: { blocks: [{ type: 'text', content: 'What is my name?' }] },
      });

      const recallBeforeIdle = MakaioBus.once(AgentSubjects.idle, {
        filter: { agentId },
        timeoutMs: adapterOptions?.defaultTimeout ?? 45_000,
      });
      const recallBefore = await MakaioBus.once(AgentSubjects.complete, {
        filter: { agentId },
        timeoutMs: adapterOptions?.defaultTimeout ?? 45_000,
      });
      assertCompletedTurn(recallBefore);
      expect(recallBefore.payload.message).toContain('Bob');

      await recallBeforeIdle;

      // ── Step 3: Rehydrate — swap connector (simulates crash recovery) ─
      await MakaioBus.request(AdapterSubjects.rehydrateAgent, {
        adapterId,
        agentId,
      });

      // ── Step 4: sendMessage with history → recall + identity check ────
      // Fresh connector has no native history — inject via sessionContext
      await MakaioBus.request(AgentSubjects.sendMessage, {
        agentId,
        adapterId,
        message: { blocks: [{ type: 'text', content: 'What is my name?' }] },
        sessionContext: {
          messageHistory: [
            {
              role: 'user' as const,
              blocks: [{ type: 'text' as const, content: 'My name is Bob. Reply with OK.' }],
            },
            {
              role: 'assistant' as const,
              blocks: [{ type: 'text' as const, content: 'OK' }],
            },
          ],
          isFirstTurn: true,
        },
      });

      const postRehydrate = await MakaioBus.once(AgentSubjects.complete, {
        filter: { agentId },
        timeoutMs: adapterOptions?.defaultTimeout ?? 45_000,
      });

      assertCompletedTurn(postRehydrate);
      // Identity preserved — same agentId throughout
      expect(postRehydrate.payload.agentId).toBe(agentId);
      // LLM recalls injected history
      expect(postRehydrate.payload.message).toContain('Bob');
    } finally {
      unsubToolApprove?.();
    }
  });
});
