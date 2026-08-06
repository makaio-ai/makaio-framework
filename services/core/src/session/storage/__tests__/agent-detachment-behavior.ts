/**
 * Shared behavioral test suite for what an agent read hands back.
 *
 * A storage read is a value, not a handle. Both backends must therefore answer
 * with rows the store no longer owns: a caller that mutates what it received
 * must not have written anything, and a whole-record write built from such a
 * mutated snapshot must still meet the guards that protect the terminal status
 * and the ownership columns.
 *
 * The suite is written so that **every arm drives the aliasing route** — it
 * mutates the object the read returned, rather than spreading it into a new one.
 * A spread would pass against a store that hands out live rows, which is the
 * shape this suite exists to reject: the whole-record write would carry the
 * store's own newer value back and the defect would be invisible.
 *
 * Call `describeAgentDetachmentBehavior()` inside a `describe` block **after**
 * the backend's lifecycle hooks have registered the session and agent handlers.
 */
import { describe, it, expect } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import type { AgentStatus, MakaioSessionAgent } from '@makaio/contracts';
import { SessionStorageSubjects } from '../namespace.js';
import { AgentStorageSubjects } from '../agent-namespace.js';
import { createSession, createAgent } from './shared.js';

/** A seeded session with one agent in it. */
interface SeededPair {
  /** Session the agent belongs to. */
  sessionId: string;
  /** The seeded agent. */
  agentId: string;
  /** Adapter name the agent was registered under. */
  adapterName: string;
}

/**
 * Seed one session and one agent through the public subjects.
 * @param status - Lifecycle status the agent row starts in.
 * @returns The seeded identifiers.
 */
async function seedPair(status: AgentStatus = 'idle'): Promise<SeededPair> {
  const sessionId = `session-${crypto.randomUUID()}`;
  await MakaioBus.request(SessionStorageSubjects.set, { sessionId, session: createSession({ sessionId }) });
  const agentId = `agent-${crypto.randomUUID()}`;
  const adapterName = `adapter-${crypto.randomUUID()}`;
  await MakaioBus.request(AgentStorageSubjects.set, {
    agentId,
    agent: createAgent({ agentId, sessionId, adapterName, status }),
  });
  return { sessionId, agentId, adapterName };
}

/**
 * Read a stored agent, failing the test when the row is gone.
 * @param agentId - Agent to read.
 * @returns The stored agent record, as the read handler answered it.
 */
async function readAgent(agentId: string): Promise<MakaioSessionAgent> {
  const { agent } = await MakaioBus.request(AgentStorageSubjects.get, { agentId });
  if (agent === null) throw new Error(`agent "${agentId}" is not stored`);
  return agent;
}

/**
 * Registers the shared agent-detachment behavior tests for one backend.
 */
export function describeAgentDetachmentBehavior(): void {
  describe('reads hand back nothing the store still owns', () => {
    it('keeps the stored status when the row a get returned is mutated', async () => {
      const { agentId } = await seedPair('starting');

      const returned = await readAgent(agentId);
      returned.status = 'active';
      returned.model = 'model-from-a-mutated-read';

      const reread = await readAgent(agentId);
      expect(reread.status).toBe('starting');
      // Not only the guarded columns: a read is a value, so nothing the caller
      // does to it reaches the store.
      expect(reread.model).toBeUndefined();
    });

    it('keeps the stored status when a row from listBySession is mutated', async () => {
      const { sessionId, agentId } = await seedPair('starting');

      const listed = await MakaioBus.request(AgentStorageSubjects.listBySession, { sessionId });
      const target = listed.agents.find((agent) => agent.agentId === agentId);
      if (!target) throw new Error('the seeded agent is missing from listBySession');
      target.status = 'active';

      expect((await readAgent(agentId)).status).toBe('starting');
    });

    it('keeps the stored status when a row from listByAdapter is mutated', async () => {
      const { agentId, adapterName } = await seedPair('starting');

      const listed = await MakaioBus.request(AgentStorageSubjects.listByAdapter, { adapterName, status: 'all' });
      const target = listed.agents.find((agent) => agent.agentId === agentId);
      if (!target) throw new Error('the seeded agent is missing from listByAdapter');
      target.status = 'active';

      expect((await readAgent(agentId)).status).toBe('starting');
    });

    it('keeps the stored status when an agent embedded in a session read is mutated', async () => {
      // The leak path: the session read composes the same rows the agent read
      // hands out, so a store that aliases them leaks through both surfaces.
      const { sessionId, agentId } = await seedPair('starting');

      const { session } = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      const embedded = session?.agents.find((agent) => agent.agentId === agentId);
      if (!embedded) throw new Error('the seeded agent is missing from the session read');
      embedded.status = 'active';

      expect((await readAgent(agentId)).status).toBe('starting');
    });

    it('cannot revive a disposed agent through a mutated snapshot', async () => {
      const { agentId } = await seedPair('idle');
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'disposed' });

      // The write-side half. `set` preserves a stored `disposed` by comparing
      // against the row it is replacing, so the comparison is only as good as
      // that row: a caller mutating what a read handed it must not be able to
      // change what the guard compares against.
      const snapshot = await readAgent(agentId);
      snapshot.status = 'active';
      await MakaioBus.request(AgentStorageSubjects.set, { agentId, agent: snapshot });

      expect((await readAgent(agentId)).status).toBe('disposed');
    });

    it('cannot revive a disposed agent through a mutated row from a session read', async () => {
      const { sessionId, agentId } = await seedPair('idle');
      await MakaioBus.request(AgentStorageSubjects.updateStatus, { agentId, status: 'disposed' });

      const { session } = await MakaioBus.request(SessionStorageSubjects.get, { sessionId });
      const embedded = session?.agents.find((agent) => agent.agentId === agentId);
      if (!embedded) throw new Error('the seeded agent is missing from the session read');
      embedded.status = 'active';
      await MakaioBus.request(AgentStorageSubjects.set, { agentId, agent: embedded });

      expect((await readAgent(agentId)).status).toBe('disposed');
    });

    it('keeps the stored ownership projection when a mutated snapshot is written back', async () => {
      const { agentId } = await seedPair('idle');

      const snapshot = await readAgent(agentId);
      snapshot.revision = 99;
      snapshot.currencyFence = 99;
      snapshot.currentAdapterSessionId = 'invented-by-a-reader';
      snapshot.currentAdapterSessionIdState = 'confirmed';
      await MakaioBus.request(AgentStorageSubjects.set, { agentId, agent: snapshot });

      const stored = await readAgent(agentId);
      expect(stored.revision).toBe(0);
      expect(stored.currencyFence).toBe(0);
      expect(stored.currentAdapterSessionId).toBeUndefined();
      expect(stored.currentAdapterSessionIdState).toBe('inherited');
    });
  });
}
