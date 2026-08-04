/**
 * Contract tests for the agent recovery plan.
 *
 * The plan exists so a recovery's two halves — the `adapter.rehydrateAgent`
 * call and the history assembly that accompanies it — read one decision instead
 * of two independently derived ones. These tests exercise the real recovery
 * helpers against the in-memory storage backends, so the assembled history is
 * the conversation actually stored for the session.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, type MakaioSessionAgent, type SessionContext } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { MessageStorageSubjects } from '../messages/namespace.js';
import { registerMemoryMessageStorage } from '../messages/memory-handler.js';
import { registerMemorySessionEventStorage } from '../session-events/memory-handler.js';
import { SessionStorageSubjects } from '../storage/namespace.js';
import { registerMemorySessionStorage } from '../storage/memory-handler.js';
import {
  FRESH_WITH_HISTORY_RECOVERY_PLAN,
  planAgentRecovery,
  recoveryPlanRequiresHistory,
  recoveryPlanResumeTarget,
  type RecoveryPlan,
} from '../recovery-plan.js';
import { recoverAgent } from '../utils/agent-recovery.js';
import { buildPlannedRecoveryContext } from '../utils/recovery-context.js';
import { createTestAgent } from './shared.js';

const SESSION_ID = 'session-recovery-plan';
const AGENT_ID = 'agent-recovery-plan';
const PROVIDER_SESSION_ID = 'provider-session-recovery-plan';

/** Outcome of one recovery, as seen by both consumers of the plan. */
interface RecoveryOutcome {
  /** Resume target the adapter received, or `undefined` for a fresh connector. */
  readonly rehydratedWith: string | undefined;
  /** Context handed to the next turn, or `undefined` when no history was injected. */
  readonly context: SessionContext | undefined;
}

describe('recovery plan', () => {
  let bus: IMakaioBus;
  let cleanups: Array<() => void>;
  let rehydratePayloads: Array<{ agentId: string; resumeAdapterSessionId?: string }>;

  beforeEach(async () => {
    bus = createBusInstance();
    rehydratePayloads = [];
    cleanups = [
      registerMemorySessionStorage(bus),
      registerMemoryMessageStorage(bus),
      registerMemorySessionEventStorage(bus),
      bus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
        ctx.setResult({ adapterId: `current-${ctx.payload.adapterName}` });
      }),
      bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
        rehydratePayloads.push(ctx.payload);
        ctx.setResult({});
      }),
    ];
    await seedConversation(bus);
  });

  afterEach(() => {
    for (const cleanup of cleanups.reverse()) cleanup();
  });

  describe('planAgentRecovery', () => {
    it('resumes natively only when the verdict is native and the agent owns a provider session', () => {
      expect(planAgentRecovery({ kind: 'native' }, PROVIDER_SESSION_ID)).toEqual({
        kind: 'native-resume',
        resumeAdapterSessionId: PROVIDER_SESSION_ID,
      });
    });

    it('stays fresh-with-history for a native verdict on an agent with no provider session', () => {
      expect(planAgentRecovery({ kind: 'native' }, undefined)).toEqual(FRESH_WITH_HISTORY_RECOVERY_PLAN);
    });

    it('stays fresh-with-history for non-native verdicts even when a provider session exists', () => {
      expect(planAgentRecovery({ kind: 'degrade', reason: 'adapter-session-moved' }, PROVIDER_SESSION_ID)).toEqual(
        FRESH_WITH_HISTORY_RECOVERY_PLAN,
      );
      expect(planAgentRecovery({ kind: 'foreign', machineId: 'other-machine' }, PROVIDER_SESSION_ID)).toEqual(
        FRESH_WITH_HISTORY_RECOVERY_PLAN,
      );
    });
  });

  describe('the two consumers read one decision', () => {
    it('warm-fresh recovery starts the agent with the full stored conversation and no provider resume', async () => {
      const outcome = await executeRecovery(bus, FRESH_WITH_HISTORY_RECOVERY_PLAN, rehydratePayloads);

      expect(outcome.rehydratedWith).toBeUndefined();
      expect(outcome.context?.isFirstTurn).toBe(true);
      expect(outcome.context?.messageHistory?.map((entry) => entry.role)).toEqual(['user', 'assistant', 'user']);
    });

    it('native-resume recovery resumes the provider session and replays no history', async () => {
      const plan: RecoveryPlan = { kind: 'native-resume', resumeAdapterSessionId: PROVIDER_SESSION_ID };

      const outcome = await executeRecovery(bus, plan, rehydratePayloads);

      expect(outcome.rehydratedWith).toBe(PROVIDER_SESSION_ID);
      expect(outcome.context).toBeUndefined();
    });

    it('never grants a resume target and injected history at the same time', async () => {
      const plans: RecoveryPlan[] = [
        FRESH_WITH_HISTORY_RECOVERY_PLAN,
        { kind: 'native-resume', resumeAdapterSessionId: PROVIDER_SESSION_ID },
      ];

      for (const plan of plans) {
        // The predicate the history side reads and the target the rehydrate side
        // reads are two views of the same decision, never independently true.
        expect(recoveryPlanRequiresHistory(plan)).toBe(recoveryPlanResumeTarget(plan) === undefined);

        rehydratePayloads.length = 0;
        const outcome = await executeRecovery(bus, plan, rehydratePayloads);
        expect(outcome.rehydratedWith === undefined).toBe(outcome.context !== undefined);
      }
    });
  });
});

/**
 * Run a recovery exactly the way a caller must: one plan, both consumers.
 * @param bus - Test bus instance
 * @param plan - Recovery plan under test
 * @param rehydratePayloads - Mutable log the adapter stub appends rehydrate payloads to
 * @returns What the adapter was asked to resume and what context the caller assembled
 */
async function executeRecovery(
  bus: IMakaioBus,
  plan: RecoveryPlan,
  rehydratePayloads: Array<{ agentId: string; resumeAdapterSessionId?: string }>,
): Promise<RecoveryOutcome> {
  const { session } = await bus.request(SessionStorageSubjects.get, { sessionId: SESSION_ID });
  if (!session) throw new Error(`Session not found: ${SESSION_ID}`);
  const agent: MakaioSessionAgent = createTestAgent(AGENT_ID, {
    sessionId: SESSION_ID,
    adapterName: 'test-adapter',
    adapterSessionId: PROVIDER_SESSION_ID,
    role: 'lead',
  });

  await recoverAgent(bus, agent, { plan }, agent.adapterId);
  const context = await buildPlannedRecoveryContext(bus, session, plan);

  const payload = rehydratePayloads.at(-1);
  if (payload === undefined) throw new Error('adapter.rehydrateAgent was not called');
  return { rehydratedWith: payload.resumeAdapterSessionId, context };
}

/**
 * Store a three-message conversation so the history side has real content.
 *
 * The memory message store emits the matching `message` session events itself,
 * which is what `getFullConversation` projects the conversation from.
 * @param bus - Test bus instance
 */
async function seedConversation(bus: IMakaioBus): Promise<void> {
  await bus.request(SessionStorageSubjects.set, {
    sessionId: SESSION_ID,
    session: {
      sessionId: SESSION_ID,
      createdAt: 1_000,
      lastActivityAt: 3_000,
      status: 'active',
      agents: [],
      adapterSessionId: PROVIDER_SESSION_ID,
    },
  });

  const turns: Array<{ messageId: string; role: 'user' | 'assistant'; text: string; timestamp: number }> = [
    { messageId: 'msg-1', role: 'user', text: 'first question', timestamp: 1_000 },
    { messageId: 'msg-2', role: 'assistant', text: 'first answer', timestamp: 2_000 },
    { messageId: 'msg-3', role: 'user', text: 'follow-up question', timestamp: 3_000 },
  ];

  for (const entry of turns) {
    await bus.request(MessageStorageSubjects.append, {
      message: {
        messageId: entry.messageId,
        sessionId: SESSION_ID,
        turnId: 'turn-1',
        role: entry.role,
        contentText: entry.text,
        blocks: [{ type: 'text', content: entry.text }],
        timestamp: entry.timestamp,
      },
    });
  }
}
