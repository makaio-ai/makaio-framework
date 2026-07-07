/**
 * Conformance tests for native session resume and fork capabilities.
 *
 * These tests verify that the capability declarations made in an adapter's
 * `ConformanceTestConfig.capabilities` are consistent with what the adapter
 * actually exposes at runtime via its declared capability strings.
 *
 * Two invariant families are covered:
 *
 * 1. **Capability declaration honesty** — `config.capabilities.nativeResume`
 *    and `config.capabilities.nativeFork` must exactly match the adapter's
 *    runtime `'session:resume'` and `'session:fork'` capability tokens.
 *    Runs without any API calls.
 *
 * 2. **Fork session-ID isolation** — when a fork request is sent through the
 *    full orchestration stack, the child session's `adapterSessionId` must
 *    differ from the source session's `adapterSessionId`. This guards against
 *    adapters that silently collapse fork into resume.
 *    Runs only for adapters that declare `nativeFork: true`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { parseAIAdapterCapabilities } from '@makaio/ai-adapters-core';
import { AdapterSubjects, AgentSubjects, SessionSubjects } from '@makaio/contracts';
import { getAdapterUnderTest, getOrchestrationTestContext, resolveModelRef } from './shared.js';

const adapterName = getAdapterUnderTest();

// ---------------------------------------------------------------------------
// 1. Capability declaration honesty (no API calls)
// ---------------------------------------------------------------------------

describe('Native session capability declarations', async () => {
  const ctx = await getOrchestrationTestContext(adapterName);

  afterAll(async () => {
    await ctx.adapter.close?.();
  });

  it('adapter capabilities match conformance nativeResume flag', () => {
    const caps = parseAIAdapterCapabilities(ctx.adapter.capabilities);
    expect(
      caps.sessionResume,
      `Adapter '${adapterName}' nativeResume conformance flag must match runtime 'session:resume' capability. ` +
        `Config nativeResume=${String(ctx.testConfig.capabilities?.nativeResume)}, actual capabilities: [${ctx.adapter.capabilities.join(', ')}]`,
    ).toBe(ctx.testConfig.capabilities?.nativeResume === true ? true : undefined);
  });

  it('adapter capabilities match conformance nativeFork flag', () => {
    const caps = parseAIAdapterCapabilities(ctx.adapter.capabilities);
    expect(
      caps.sessionFork,
      `Adapter '${adapterName}' nativeFork conformance flag must match runtime 'session:fork' capability. ` +
        `Config nativeFork=${String(ctx.testConfig.capabilities?.nativeFork)}, actual capabilities: [${ctx.adapter.capabilities.join(', ')}]`,
    ).toBe(ctx.testConfig.capabilities?.nativeFork === true ? true : undefined);
  });

  it('nativeFork requires nativeResume (fork presupposes session continuity)', () => {
    const { nativeResume, nativeFork } = ctx.testConfig.capabilities ?? {};

    if (nativeFork) {
      expect(
        nativeResume,
        `Adapter '${adapterName}' declares nativeFork=true but nativeResume is not true. ` +
          'Native fork requires the adapter to support session continuity (session:resume) as a prerequisite.',
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Fork session-ID isolation (requires real API call, skipped when nativeFork=false)
// ---------------------------------------------------------------------------

describe('Native fork session-ID isolation', async () => {
  const ctx = await getOrchestrationTestContext(adapterName);
  const nativeFork = ctx.testConfig.capabilities?.nativeFork;
  const primaryModelRef = ctx.testConfig.options?.primaryModel;
  const timeout = ctx.testConfig.options?.defaultTimeout ?? 60_000;

  let sourceAdapterSessionId: string | undefined;
  let sourceSessionId: string | undefined;
  let childAdapterSessionId: string | undefined;
  let forkAgentId: string | undefined;
  let forkAdapterId: string | undefined;
  let setupFailed = false;

  beforeAll(async () => {
    if (!nativeFork) return;

    try {
      // Start the source session
      const sourceResponse = await MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: ctx.adapterId,
        role: 'lead',
        ...resolveModelRef(primaryModelRef, ctx.testConfig.testProviderContext),
        initialMessage: 'Reply with the single word: OK',
        systemPrompt: 'You are a helpful assistant. Keep responses very brief. Do not use any tools.',
      });

      if (!sourceResponse.success) {
        setupFailed = true;
        return;
      }

      // Wait for source session to complete so we have a stable adapterSessionId
      if (sourceResponse.messageId) {
        await MakaioBus.once(AgentSubjects.complete, {
          filter: { messageId: sourceResponse.messageId },
        });
      }

      sourceAdapterSessionId = sourceResponse.adapterSessionId ?? undefined;
      sourceSessionId = sourceResponse.sessionId ?? undefined;

      if (!sourceAdapterSessionId || !sourceSessionId) {
        setupFailed = true;
        return;
      }

      // Fork from the source session. Build the request as a single object so
      // TypeScript can narrow the discriminated union on `mode: 'fork'` without
      // fighting the spread of the model-ref partial type.
      const modelRef = resolveModelRef(primaryModelRef, ctx.testConfig.testProviderContext);
      const forkResponse = await MakaioBus.request(AdapterSubjects.startAgent, {
        adapterId: ctx.adapterId,
        role: 'lead',
        mode: 'fork',
        sessionId: sourceResponse.sessionId,
        sourceSessionId: sourceResponse.sessionId,
        sourceAdapterSessionId,
        initialMessage: 'Reply with the single word: FORKED',
        systemPrompt: 'You are a helpful assistant. Keep responses very brief. Do not use any tools.',
        ...('model' in modelRef && modelRef.model !== undefined ? { model: modelRef.model } : {}),
        ...('providerContext' in modelRef ? { providerContext: modelRef.providerContext } : {}),
      });

      if (!forkResponse.success) {
        setupFailed = true;
        return;
      }

      childAdapterSessionId = forkResponse.adapterSessionId ?? undefined;
      forkAgentId = forkResponse.agentId ?? undefined;
      forkAdapterId = forkResponse.adapterId ?? undefined;

      if (forkResponse.messageId) {
        await MakaioBus.once(AgentSubjects.complete, {
          filter: { messageId: forkResponse.messageId },
        });
      }
    } catch {
      setupFailed = true;
    }
  }, timeout);

  afterAll(async () => {
    await ctx.adapter.close?.();
  });

  it('fork produces a child session with a distinct adapterSessionId', { timeout }, () => {
    if (!nativeFork) {
      // Adapter does not declare native fork — skip structural assertion.
      expect(nativeFork).toBeFalsy();
      return;
    }

    if (setupFailed) {
      throw new Error(`[native-session-conformance] Fork setup failed for '${adapterName}'.`);
    }

    expect(sourceAdapterSessionId).toBeDefined();
    expect(childAdapterSessionId).toBeDefined();
    expect(
      childAdapterSessionId,
      `Adapter '${adapterName}' native fork produced a child adapterSessionId identical to the source. ` +
        'Fork must create a new provider-side session, not resume the existing one.',
    ).not.toBe(sourceAdapterSessionId);
  });

  it('source session adapterSessionId is not mutated by a fork', { timeout }, async () => {
    if (!nativeFork) {
      expect(nativeFork).toBeFalsy();
      return;
    }

    if (setupFailed) {
      throw new Error(`[native-session-conformance] Fork setup failed for '${adapterName}'.`);
    }

    // Re-read the source session from storage AFTER the fork completed to
    // catch identity backflow: any code path that would rebind the source
    // session's adapterSessionId pointer as a side-effect of forking.
    const { session: sourceSession } = await MakaioBus.request(SessionSubjects.get, {
      sessionId: sourceSessionId!,
    });

    expect(
      sourceSession?.adapterSessionId,
      `Adapter '${adapterName}' fork mutated the source session's adapterSessionId in storage. ` +
        `Expected '${sourceAdapterSessionId}' but found '${sourceSession?.adapterSessionId}'.`,
    ).toBe(sourceAdapterSessionId);

    // Additionally confirm that the child's adapterSessionId differs — both
    // invariants belong together: source unchanged AND child is a new session.
    expect(
      childAdapterSessionId,
      `Adapter '${adapterName}' fork produced a child adapterSessionId identical to the source. ` +
        'Fork must create a new provider-side session, not resume the existing one.',
    ).not.toBe(sourceAdapterSessionId);
  });

  it('fork child resumes its own session on turn 2 without re-forking', { timeout }, async () => {
    if (!nativeFork) {
      expect(nativeFork).toBeFalsy();
      return;
    }

    if (setupFailed) {
      throw new Error(`[native-session-conformance] Fork setup failed for '${adapterName}'.`);
    }

    // Register the completion listener BEFORE sending so a fast turn cannot
    // fire AgentSubjects.complete before the listener exists (MakaioBus.once
    // does not buffer past events).
    const turn2CompletePromise = MakaioBus.once(AgentSubjects.complete, {
      filter: { agentId: forkAgentId! },
      timeoutMs: timeout,
    });

    // Send a second message to the fork child via the already-running agent.
    await MakaioBus.request(AgentSubjects.sendMessage, {
      agentId: forkAgentId!,
      adapterId: forkAdapterId!,
      message: { blocks: [{ type: 'text', content: 'Reply with the single word: AGAIN' }] },
    });

    const turn2Complete = await turn2CompletePromise;

    // (a) The child's adapterSessionId after turn 2 must equal its adapterSessionId
    //     after turn 1 — it resumed itself, not re-forked into a new provider session.
    expect(
      turn2Complete?.payload.adapterSessionId,
      `Adapter '${adapterName}' fork child's adapterSessionId changed between turn 1 and turn 2. ` +
        `Turn 1 id: '${childAdapterSessionId}', turn 2 id: '${turn2Complete?.payload.adapterSessionId}'. ` +
        'The child must resume the same provider session, not create a new one.',
    ).toBe(childAdapterSessionId);

    // (b) The source session's adapterSessionId must still be unchanged after
    //     the child has taken a second turn.
    const { session: sourceSessionAfterTurn2 } = await MakaioBus.request(SessionSubjects.get, {
      sessionId: sourceSessionId!,
    });

    expect(
      sourceSessionAfterTurn2?.adapterSessionId,
      `Adapter '${adapterName}' source session's adapterSessionId was overwritten after the fork child's turn 2. ` +
        `Expected '${sourceAdapterSessionId}' but found '${sourceSessionAfterTurn2?.adapterSessionId}'.`,
    ).toBe(sourceAdapterSessionId);
  });
});
