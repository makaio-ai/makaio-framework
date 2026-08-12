import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdapterSubjects, AgentSubjects } from '@makaio/contracts';
import { FRESH_WITH_HISTORY_RECOVERY_PLAN } from '../recovery-plan.js';
import { verifyAndRecoverAgents } from '../session-orchestrator-helpers.js';
import { callerOwnedSuccessFields } from '../testing/caller-owned-adapter-stub.js';
import { RECOVERY_HELPERS_MACHINE_ID, RecoveryHelpersHarness } from './session-orchestrator.recovery.fixture.js';

describe('SessionOrchestrator recovery helpers for legacy rows', () => {
  let harness: RecoveryHelpersHarness;

  beforeEach(async () => {
    harness = new RecoveryHelpersHarness();
    await harness.init();
  });

  afterEach(() => {
    harness.destroy();
  });

  it('defers a legacy row without probing, recovering, routing, or stopping it', async () => {
    const legacyAgent = await harness.seedAgent('legacy-ownerless-agent', { runtimeOwner: undefined });
    const calls = { getAgent: 0, rehydrate: 0, route: 0, stop: 0 };
    harness.addCleanup(
      harness.bus.on(AdapterSubjects.getAgent, (ctx) => {
        calls.getAgent += 1;
        ctx.setResult({ agent: null });
      }),
    );
    harness.addCleanup(
      harness.bus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
        calls.rehydrate += 1;
        ctx.setResult({ success: true, ...callerOwnedSuccessFields(ctx.payload) });
      }),
    );
    harness.addCleanup(
      harness.bus.on(AgentSubjects.sendMessage, () => {
        calls.route += 1;
      }),
    );
    harness.addCleanup(
      harness.bus.on(AdapterSubjects.stopAgent, (ctx) => {
        calls.stop += 1;
        ctx.setResult({ success: true, evidence: 'released' });
      }),
    );

    const verified = await verifyAndRecoverAgents(harness.bus, [legacyAgent], {
      plan: FRESH_WITH_HISTORY_RECOVERY_PLAN,
      machineId: RECOVERY_HELPERS_MACHINE_ID,
    });

    expect(verified.usable).toEqual([]);
    expect(verified.recoveredAgentIds).toEqual(new Set());
    expect(verified.deferredAgentIds).toEqual(new Set([legacyAgent.agentId]));
    expect(calls).toEqual({ getAgent: 0, rehydrate: 0, route: 0, stop: 0 });
  });
});
