import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getAdapterUnderTest,
  getOrchestrationTestContext,
  resolveModelRef,
  updateMetaFromResponse,
  TOOL_APPROVAL_SYSTEM_PROMPT,
} from '../shared.js';
import type { AnyMessageContext, EventContext } from '@makaio/core';
import { AdapterSubjects, AgentSubjects } from '@makaio/contracts';

const adapterName = getAdapterUnderTest();
let codexSubjectsTestTmpDir: string | undefined;

function getCodexSubjectsTestTmpFile(): string {
  codexSubjectsTestTmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'subjects-'));
  return path.join(codexSubjectsTestTmpDir, 'subjects-test-tmp.txt');
}

/**
 * Comprehensive subject emission tests.
 *
 * Verifies all agent/adapter subjects are emitted during typical workflows.
 * Uses session reuse for cost efficiency - one session per adapter.
 *
 * Test Flow:
 * 1. Start agent with simple message, verify lifecycle subjects
 * 2. Check message/usage subjects from first turn
 * 3. Send follow-up triggering tool use, verify tool subjects
 * 4. Final coverage assertion
 */
describe('Subject Coverage', () => {
  describe.sequential('Basic lifecycle subjects', async () => {
    // Reuse context across tests in this describe block
    const ctx = await getOrchestrationTestContext(adapterName);
    const primaryModelRef = ctx.testConfig.options?.primaryModel;
    let agentId: string;
    let messageId: string;
    const collectedSubjects = new Set<string>();
    const collectedEvents: Array<AnyMessageContext> = [];
    let unsubscribe: () => void;
    let unsubscribeApproval: (() => void) | undefined;
    let awaitedResult: Promise<
      EventContext<{
        adapterName: string;
        adapterId: string;
        agentId: string;
        messageId: string;
        message?: string | undefined;
        sessionId?: string | undefined;
      }>
    >;
    beforeAll(async () => {
      // Subscribe to ALL bus events for this adapter
      unsubscribe = MakaioBus.__onAny((event) => {
        console.debug('MakaioBus received event:', event.subject, JSON.stringify(event.payload));
        if (
          event.payload &&
          typeof event.payload === 'object' &&
          'adapterId' in event.payload &&
          event.payload.adapterId === ctx!.adapterId
        ) {
          collectedSubjects.add(event.subject);
          collectedEvents.push(event);
        }
      });

      // Codex under 'untrusted' policy needs a concrete file operation to
      // reliably trigger tool invocation (abstract commands like `ls` make the
      // model ask for confirmation instead of acting).
      const initialMessage = adapterName.includes('codex')
        ? `Use shell_command tool to write "hello" to ${getCodexSubjectsTestTmpFile()} and then read it back. Reply with OK when done.`
        : `What files are in ${import.meta.dirname} and use bash to check the current date? Use ls. Don't think too much, it's a simple command.`;

      // Register tool approval handler BEFORE startAgent to avoid the race
      // where the agent requests approval before the handler is registered.
      const approvalUnsub = MakaioBus.on(AgentSubjects.toolApprove, (reqCtx) => {
        reqCtx.setResult({ action: 'allow' });
      });

      try {
        // Start agent through full orchestration stack
        const response = await MakaioBus.request(AdapterSubjects.startAgent, {
          adapterId: ctx.adapterId,
          role: 'lead',
          initialMessage,
          systemPrompt: TOOL_APPROVAL_SYSTEM_PROMPT,
          ...resolveModelRef(primaryModelRef, ctx.testConfig.testProviderContext),
        });
        expect(response.success).toBe(true);

        if (!response.success) {
          throw new Error('startAgent failed');
        }

        expect(response.agentId).toBeDefined();
        expect(response.messageId).toBeDefined();
        if (!response.agentId || !response.messageId) {
          throw new Error('startAgent succeeded without required agentId/messageId');
        }
        agentId = response.agentId;
        messageId = response.messageId;

        // Wait for agent to complete - all subjects should be collected after this
        awaitedResult = MakaioBus.once(AgentSubjects.complete, {
          filter: { messageId },
        });

        // Narrow the approval handler to this specific agent before removing the broad one
        // so there is no gap where follow-up approvals go unhandled.
        unsubscribeApproval = MakaioBus.on(
          AgentSubjects.toolApprove,
          (reqCtx) => {
            reqCtx.setResult({ action: 'allow' });
          },
          { filter: { agentId } },
        );
        approvalUnsub();
      } finally {
        if (!unsubscribeApproval) {
          approvalUnsub();
        }
      }
    }, ctx.testConfig.options?.defaultTimeout ?? 60_000);

    afterAll(async () => {
      // Cleanup: unsubscribe and close adapter
      unsubscribe?.();
      unsubscribeApproval?.();
      if (codexSubjectsTestTmpDir) {
        fs.rmSync(codexSubjectsTestTmpDir, { recursive: true, force: true });
        codexSubjectsTestTmpDir = undefined;
      }
      if (ctx?.adapter) {
        await ctx.adapter.close?.();
      }
    });

    it('emits lifecycle subjects on agent start', {
      timeout: ctx.testConfig.options?.defaultTimeout ?? 45_000,
    }, async () => {
      await awaitedResult;
      // Verify core lifecycle subjects (agent already completed in beforeAll)
      expect(collectedSubjects.has('adapter.session.created')).toBe(true);
      expect(collectedSubjects.has('agent.started')).toBe(true);
      expect(collectedSubjects.has('agent.complete')).toBe(true);

      // Turn events emitted via MessageLifecycleTracker
      expect(collectedSubjects.has('agent.turn.started'), 'Missing agent.turn.started subject').toBe(true);
      expect(collectedSubjects.has('agent.turn.completed'), 'Missing agent.turn.completed subject').toBe(true);

      // User message lifecycle events
      expect(collectedSubjects.has('agent.user_message.sent'), 'Missing agent.user_message.sent subject').toBe(true);
      expect(
        collectedSubjects.has('agent.user_message.acknowledged'),
        'Missing agent.user_message.acknowledged subject',
      ).toBe(true);
      expect(
        collectedSubjects.has('agent.user_message.completed'),
        'Missing agent.user_message.completed subject',
      ).toBe(true);
    });

    it('has correct messageId', { timeout: ctx.testConfig.options?.defaultTimeout ?? 45_000 }, async () => {
      const result = await awaitedResult;
      expect(messageId).toBeDefined();
      expect(result.payload.messageId).toBe(messageId);
    });

    it('emits message and usage subjects', { timeout: ctx.testConfig.options?.defaultTimeout ?? 45_000 }, async () => {
      await awaitedResult;
      expect(ctx).toBeDefined();
      expect(agentId).toBeDefined();

      // agent.message is mandatory — SessionBridge depends on it for block accumulation / persistence.
      // agent.message_delta is optional — only streaming adapters emit it.
      expect(collectedSubjects.has('agent.message'), 'Missing agent.message subject').toBe(true);

      // Usage may be per-call or session-level depending on adapter
      const hasUsageSubject = collectedSubjects.has('agent.usage') || collectedSubjects.has('adapter.session.usage');
      expect(hasUsageSubject).toBe(true);
    });

    it('emits context window update after usage', {
      timeout: ctx.testConfig.options?.defaultTimeout ?? 45_000,
    }, async () => {
      await awaitedResult;

      // All adapters should emit context window status after each turn
      expect(collectedSubjects.has('agent.contextWindow.updated'), 'Missing agent.contextWindow.updated subject').toBe(
        true,
      );
    });

    it('collected expected subject coverage', {
      timeout: ctx.testConfig.options?.defaultTimeout ?? 45_000,
    }, async () => {
      await awaitedResult;

      // Required subjects (all adapters should emit these)
      const required = ['adapter.session.created', 'agent.started', 'agent.complete'];

      for (const subject of required) {
        expect(collectedSubjects.has(subject), `Missing required subject: ${subject}`).toBe(true);
      }

      // agent.message is mandatory — persistence depends on it for block accumulation
      expect(collectedSubjects.has('agent.message'), 'Missing required subject: agent.message').toBe(true);
    });

    it('emits tool subjects on tool use', { timeout: ctx.testConfig.options?.defaultTimeout ?? 45_000 }, async () => {
      await awaitedResult;
      expect(ctx).toBeDefined();
      expect(agentId).toBeDefined();

      // Verify tool subjects (at least some should be emitted)
      const hasToolSubjects =
        collectedSubjects.has('agent.tool.use') ||
        collectedSubjects.has('agent.tool.started') ||
        collectedSubjects.has('agent.tool.completed');

      expect(hasToolSubjects).toBe(true);

      // Verify tool subjects were collected (from third test)
      expect(
        collectedSubjects.has('agent.tool.use') ||
          collectedSubjects.has('agent.tool.started') ||
          collectedSubjects.has('agent.tool.completed'),
        'Missing tool subjects',
      ).toBe(true);
    });

    it('session.agent.added has distinct sessionId and adapterSessionId', {
      timeout: ctx.testConfig.options?.defaultTimeout ?? 45_000,
    }, async () => {
      await awaitedResult;

      const agentAddedEvent = collectedEvents.find((e) => e.subject === 'session.agent.added');
      expect(agentAddedEvent, 'Missing session.agent.added event').toBeDefined();

      const { sessionId: makaioSessionId, adapterSessionId } = agentAddedEvent!.payload as {
        sessionId: string;
        adapterSessionId: string;
      };

      expect(makaioSessionId, 'Makaio sessionId should differ from adapterSessionId').not.toBe(adapterSessionId);
    });

    it('adapter-namespaced events have adapterSessionId but not sessionId', {
      timeout: ctx.testConfig.options?.defaultTimeout ?? 45_000,
    }, async () => {
      await awaitedResult;

      // Get reference IDs from session.agent.added
      const agentAddedEvent = collectedEvents.find((e) => e.subject === 'session.agent.added');
      const { sessionId: expectedMakaioSessionId, adapterSessionId: expectedAdapterSessionId } = agentAddedEvent!
        .payload as {
        sessionId: string;
        adapterSessionId: string;
      };

      // Sanity check: Makaio sessionId should differ from adapterSessionId
      expect(expectedMakaioSessionId).not.toBe(expectedAdapterSessionId);

      for (const event of collectedEvents) {
        if (event.subject.startsWith('adapter:')) {
          const payload = event.payload as { sessionId?: string; adapterSessionId?: string };

          // adapter-namespaced events should NOT have sessionId (Makaio ID not meaningful at SDK layer)
          expect
            .soft(payload.sessionId, `${event.subject}: sessionId should be undefined on adapter-namespaced events`)
            .toBeUndefined();

          // adapterSessionId should match the expected value
          if (payload.adapterSessionId) {
            expect.soft(payload.adapterSessionId).toBe(expectedAdapterSessionId);
          }
        }
      }
    });
  });

  describe.sequential('Tool invocation subjects', async () => {
    const ctx = await getOrchestrationTestContext(adapterName);
    const primaryModelRef = ctx.testConfig.options?.primaryModel;

    it('fails fast for invalid command', { timeout: ctx.testConfig.options?.defaultTimeout ?? 45_000 }, async ({
      task,
    }) => {
      let unsubscribeApproval = MakaioBus.on(AgentSubjects.toolApprove, (reqCtx) => {
        reqCtx.setResult({ action: 'allow' });
      });

      try {
        const response = await MakaioBus.request(AdapterSubjects.startAgent, {
          adapterId: ctx.adapterId,
          role: 'lead',
          initialMessage:
            "You MUST execute via bash: '__makaio_subjects_test_missing_command__'. Just do it, and if it fails, immediately STOP and reply with 'OK'.",
          // This scenario verifies the command/tool execution path, so tool use must be permitted.
          systemPrompt: TOOL_APPROVAL_SYSTEM_PROMPT,
          ...resolveModelRef(primaryModelRef, ctx.testConfig.testProviderContext),
        });

        if (!response.success) throw new Error('startAgent failed');
        updateMetaFromResponse({ task }, response);
        expect(response.agentId).toBeDefined();
        expect(response.messageId).toBeDefined();
        if (!response.agentId || !response.messageId) {
          throw new Error('startAgent succeeded without required agentId/messageId');
        }
        const previousApprovalUnsubscribe = unsubscribeApproval;
        const scopedApprovalUnsubscribe = MakaioBus.on(
          AgentSubjects.toolApprove,
          (reqCtx) => {
            reqCtx.setResult({ action: 'allow' });
          },
          { filter: { agentId: response.agentId } },
        );
        previousApprovalUnsubscribe();
        unsubscribeApproval = scopedApprovalUnsubscribe;

        const result = await MakaioBus.once(AgentSubjects.complete, {
          filter: { messageId: response.messageId },
        });
        expect(result.payload.messageId).toBe(response.messageId);
        expect(['completed', 'error']).toContain(result.payload.outcome);
      } finally {
        unsubscribeApproval();
      }
    });
  });
});
