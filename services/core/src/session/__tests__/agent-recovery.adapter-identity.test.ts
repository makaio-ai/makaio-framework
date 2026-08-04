import { beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, type MakaioSessionAgent } from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { verifyAndRecoverAgents } from '../utils/agent-recovery.js';
import { FRESH_WITH_HISTORY_RECOVERY_PLAN } from '../recovery-plan.js';
import { createTestAgent, resetBusHandlers } from './shared.js';

/**
 * A dead agent belonging to a named adapter, with a deliberately stale
 * `adapterId` so a resolution that never happens is visible in the dispatch.
 * @param agentId - Agent identifier
 * @param adapterName - Adapter type this agent belongs to
 * @returns Dead agent record
 */
function deadAgentOf(agentId: string, adapterName: string): MakaioSessionAgent {
  return createTestAgent(agentId, {
    sessionId: 'session-multi-adapter',
    adapterName,
    adapterId: `stale-${adapterName}`,
    status: 'dead',
  });
}

describe('verifyAndRecoverAgents adapter identity', () => {
  beforeEach(() => {
    resetBusHandlers();
  });

  it('resolves an adapter instance per dead agent, so a batch may span adapters', async () => {
    // One recovery config, two adapters: a batch-wide adapter ID would
    // rehydrate one of these agents into the other adapter's instance.
    const agents = [deadAgentOf('dead-claude', 'claude-code'), deadAgentOf('dead-codex', 'codex')];

    MakaioBus.on(AdapterSubjects.getAgent, (ctx) => {
      ctx.setResult({ agent: null }); // Both agents are dead
    });
    MakaioBus.on(AdapterRuntimeSubjects.resolveId, (ctx) => {
      ctx.setResult({ adapterId: `live-${ctx.payload.adapterName}` });
    });

    const rehydrateTargets: Array<{ agentId: string; adapterId: string }> = [];
    MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateTargets.push({ agentId: ctx.payload.agentId, adapterId: ctx.payload.adapterId });
      ctx.setResult({});
    });

    const { verifiedAgents, recoveredAgentIds } = await verifyAndRecoverAgents(MakaioBus, agents, {
      plan: FRESH_WITH_HISTORY_RECOVERY_PLAN,
    });

    expect(rehydrateTargets).toEqual([
      { agentId: 'dead-claude', adapterId: 'live-claude-code' },
      { agentId: 'dead-codex', adapterId: 'live-codex' },
    ]);
    // Each recovered record carries the instance it was actually rehydrated
    // into, so a later ownership act names the same one.
    expect(verifiedAgents.map((agent) => agent.adapterId)).toEqual(['live-claude-code', 'live-codex']);
    expect(recoveredAgentIds).toEqual(new Set(['dead-claude', 'dead-codex']));
  });

  it('falls back to the stored adapter ID when no live instance answers', async () => {
    // Recovery must still be attempted: an unresolvable adapter name is a
    // routing question, not evidence that the agent is beyond recovery.
    const agent = deadAgentOf('dead-unresolvable', 'claude-code');

    MakaioBus.on(AdapterSubjects.getAgent, (ctx) => {
      ctx.setResult({ agent: null });
    });
    const rehydrateTargets: string[] = [];
    MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
      rehydrateTargets.push(ctx.payload.adapterId);
      ctx.setResult({});
    });

    await verifyAndRecoverAgents(MakaioBus, [agent], { plan: FRESH_WITH_HISTORY_RECOVERY_PLAN });

    expect(rehydrateTargets).toEqual(['stale-claude-code']);
  });
});
