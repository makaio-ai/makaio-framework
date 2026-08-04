/**
 * Shared behavioral test suite for the agent-status surface of agent storage.
 *
 * Both the Drizzle and memory backends implement the same contract
 * (`AgentStorageSubjects.updateStatus` and `listByAdapter`'s status filter), so
 * the expectations live here once and each backend only supplies its own
 * lifecycle. A divergence then fails in one of the two invoking files rather
 * than in production.
 *
 * Call `describeAgentStatusBehavior()` inside a `describe` block **after** the
 * backend's lifecycle hooks have registered the session and agent handlers: the
 * suite seeds through the public subjects, and agents need their session row.
 */
import { describe, it, expect } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { AgentStatus, MakaioSessionAgent } from '@makaio/contracts';
import { SessionStorageSubjects } from '../namespace.js';
import { AgentStorageSubjects } from '../agent-namespace.js';
import { createSession, createAgent } from './shared.js';

/**
 * Seed one session and one agent through the registered backend.
 * @param status - Lifecycle status the agent row starts in.
 * @returns The seeded agent ID.
 */
async function seedAgent(status: AgentStatus): Promise<string> {
  const sessionId = `session-${crypto.randomUUID()}`;
  await MakaioBus.request(SessionStorageSubjects.set, { sessionId, session: createSession({ sessionId }) });
  const agentId = `agent-${crypto.randomUUID()}`;
  await MakaioBus.request(AgentStorageSubjects.set, { agentId, agent: createAgent({ agentId, sessionId, status }) });
  return agentId;
}

/**
 * Read a stored agent, failing the test when the row is gone.
 * @param agentId - Agent to read.
 * @returns The stored agent record.
 */
async function readAgent(agentId: string): Promise<MakaioSessionAgent> {
  const { agent } = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
  if (agent === null) throw new Error(`agent "${agentId}" is not stored`);
  return agent;
}

/**
 * Read the stored status of an agent, failing the test when the row is gone.
 * @param agentId - Agent to read.
 * @returns The stored lifecycle status.
 */
async function readStatus(agentId: string): Promise<AgentStatus> {
  return (await readAgent(agentId)).status;
}

/**
 * Registers the shared agent-status behavior tests for one backend.
 */
export function describeAgentStatusBehavior(): void {
  describe("updateStatus (compare-and-swap on 'starting')", () => {
    it('refuses the transition when the stored status is outside the expectation', async () => {
      const agentId = await seedAgent('disposed');

      const result = await MakaioBus.request(AgentStorageSubjects.updateStatus, {
        agentId,
        status: 'idle',
        expectedStatus: ['starting'],
      });

      // The row is there — it simply was not in a state this caller may leave.
      expect(result).toEqual({ success: true, transitioned: false });
      expect(await readStatus(agentId)).toBe('disposed');
    });

    it('applies the transition when the stored status is inside the expectation', async () => {
      const agentId = await seedAgent('starting');

      const result = await MakaioBus.request(AgentStorageSubjects.updateStatus, {
        agentId,
        status: 'idle',
        expectedStatus: ['starting'],
      });

      expect(result).toEqual({ success: true, transitioned: true });
      expect(await readStatus(agentId)).toBe('idle');
    });

    it('lets exactly one of two racing expectations win', async () => {
      const agentId = await seedAgent('starting');

      // The cross-process arbitration this field exists for: a recovery claiming
      // the start and the owner completing it both name `starting`, so whichever
      // lands second is told it lost instead of overwriting the winner.
      const recovered = await MakaioBus.request(AgentStorageSubjects.updateStatus, {
        agentId,
        status: 'dead',
        expectedStatus: ['starting'],
      });
      const completed = await MakaioBus.request(AgentStorageSubjects.updateStatus, {
        agentId,
        status: 'idle',
        expectedStatus: ['starting'],
      });

      expect(recovered.transitioned).toBe(true);
      expect(completed.transitioned).toBe(false);
      expect(await readStatus(agentId)).toBe('dead');
    });

    it('accepts any member of a multi-valued expectation', async () => {
      const agentId = await seedAgent('active');

      const result = await MakaioBus.request(AgentStorageSubjects.updateStatus, {
        agentId,
        status: 'dead',
        expectedStatus: ['starting', 'idle', 'active'],
      });

      expect(result).toEqual({ success: true, transitioned: true });
      expect(await readStatus(agentId)).toBe('dead');
    });

    it('writes unconditionally when no expectation is supplied', async () => {
      const agentId = await seedAgent('dead');

      const result = await MakaioBus.request(AgentStorageSubjects.updateStatus, {
        agentId,
        status: 'idle',
      });

      expect(result).toEqual({ success: true, transitioned: true });
      expect(await readStatus(agentId)).toBe('idle');
    });

    it('reports a missing agent as unsuccessful with and without an expectation', async () => {
      // `success` is the row's existence, so the two shapes must agree here and
      // separate only where a row exists to refuse the write.
      expect(await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId: 'absent', status: 'dead' })).toEqual(
        { success: false, transitioned: false },
      );

      expect(
        await MakaioBus.request(AgentStorageSubjects.updateStatus, {
          agentId: 'absent',
          status: 'dead',
          expectedStatus: ['starting'],
        }),
      ).toEqual({ success: false, transitioned: false });
    });
  });

  describe('disposed is terminal', () => {
    it('refuses an unconditional transition out of disposed', async () => {
      const agentId = await seedAgent('disposed');

      // The shape the adapter's post-rehydrate write has: no expectation, and a
      // status that would make the agent look live again. `success` still reports
      // the row's existence, so the refusal is visible as `transitioned: false`.
      const result = await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'idle' });

      expect(result).toEqual({ success: true, transitioned: false });
      expect(await readStatus(agentId)).toBe('disposed');
    });

    it('refuses even when the expectation names disposed', async () => {
      const agentId = await seedAgent('disposed');

      // Terminal outranks the compare-and-swap: naming the state does not make it
      // leavable, or the guarantee would be one `expectedStatus` away from gone.
      const result = await MakaioBus.request(AgentStorageSubjects.updateStatus, {
        agentId,
        status: 'idle',
        expectedStatus: ['disposed', 'starting'],
      });

      expect(result).toEqual({ success: true, transitioned: false });
      expect(await readStatus(agentId)).toBe('disposed');
    });

    it('reports a repeated disposal as untransitioned rather than failed', async () => {
      const agentId = await seedAgent('disposed');

      const result = await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'disposed' });

      // Nothing was written, and nothing needed to be: the row already says what
      // the caller wanted it to say.
      expect(result).toEqual({ success: true, transitioned: false });
      expect(await readStatus(agentId)).toBe('disposed');
    });

    it('keeps the stored disposed status across a whole-record write', async () => {
      const agentId = await seedAgent('disposed');
      const stored = await readAgent(agentId);

      // A caller-held snapshot taken before the disposal, written back after it —
      // the resurrection route a status-only guard would leave open. Its other
      // fields still land: only the terminal column is protected.
      await MakaioBus.request(AgentStorageSubjects.set, {
        agentId,
        agent: { ...stored, status: 'idle', model: 'model-from-snapshot' },
      });

      const agent = await readAgent(agentId);
      expect(agent.status).toBe('disposed');
      expect(agent.model).toBe('model-from-snapshot');
    });

    it('lets a whole-record write move any non-terminal status', async () => {
      const agentId = await seedAgent('starting');
      const stored = await readAgent(agentId);

      // The counterpart the rule must not break: a start or rehydrate reporting
      // its connector ready still writes `idle` through the whole-record seam.
      await MakaioBus.request(AgentStorageSubjects.set, { agentId, agent: { ...stored, status: 'idle' } });

      expect(await readStatus(agentId)).toBe('idle');
    });
  });

  describe("listByAdapter ('starting' status filter)", () => {
    it("filters 'starting' agents and includes them under 'all'", async () => {
      const adapterName = `adapter-${crypto.randomUUID()}`;
      const sessionId = `session-${crypto.randomUUID()}`;
      await MakaioBus.request(SessionStorageSubjects.set, { sessionId, session: createSession({ sessionId }) });

      for (const status of ['starting', 'idle'] as const) {
        const agentId = `agent-${status}-${crypto.randomUUID()}`;
        await MakaioBus.request(AgentStorageSubjects.set, {
          agentId,
          agent: createAgent({ agentId, sessionId, adapterName, status }),
        });
      }

      const starting = await MakaioBus.request(AgentStorageSubjects.listByAdapter, {
        adapterName,
        status: 'starting',
      });
      expect(starting.agents.map((agent) => agent.status)).toEqual(['starting']);

      const all = await MakaioBus.request(AgentStorageSubjects.listByAdapter, { adapterName, status: 'all' });
      expect(all.agents.map((agent) => agent.status).sort()).toEqual(['idle', 'starting']);
    });
  });
}
