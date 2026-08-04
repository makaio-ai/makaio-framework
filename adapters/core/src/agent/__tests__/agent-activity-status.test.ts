/**
 * The per-turn activity stamp is advisory inside its own domain.
 *
 * `agent.sendMessage` stamps `active` and the completion emitter stamps `idle`,
 * both fire-and-forget, so either write can land arbitrarily late — including
 * after the start that owned the row was retired. An unconditional write there
 * resurrects a row whose connector is stopped and whose ownership generation is
 * abandoned, which is the phantom agent the whole reserved-start discipline
 * exists to remove.
 *
 * Driven against the real memory agent-storage backend over the real bus: the
 * compare-and-swap under test *is* the storage behaviour, so a stubbed handler
 * would assert nothing. The only stand-in is the gate that holds one write in
 * flight, which is what makes the interleaving deterministic instead of timed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import type { MakaioSessionAgent } from '@makaio/contracts';
import {
  AgentStorageSubjects,
  createSessionStorageMemoryState,
  registerMemoryAgentStorage,
  type SessionStorageMemoryState,
} from '@makaio/services-core/session';
import { updateAgentActivityStatusBestEffort } from '../agent-storage-status.js';

const AGENT_ID = 'activity-stamp-agent';
const SESSION_ID = 'activity-stamp-session';

describe('the per-turn activity stamp', () => {
  let bus: IMakaioBus;
  let state: SessionStorageMemoryState;
  let cleanups: Array<() => void>;
  /** Callers waiting for a stamp of a given status to have been answered. */
  let answered: Map<string, Array<() => void>>;
  /** Held in front of the backend, so one write can be suspended in flight. */
  let gate: Promise<void> | undefined;

  beforeEach(() => {
    bus = createBusInstance();
    state = createSessionStorageMemoryState();
    answered = new Map();
    gate = undefined;
    // Registered before the backend so it sees every write first: the memory
    // handler answers, and the first registered request handler wins.
    cleanups = [
      bus.on(
        AgentStorageSubjects.updateStatus,
        async (ctx) => {
          if (ctx.payload.status === 'active' && gate !== undefined) await gate;
          await ctx.next();
          answered.get(ctx.payload.status)?.shift()?.();
        },
        { priority: 100 },
      ),
      registerMemoryAgentStorage(bus, state),
    ];
  });

  afterEach(() => {
    for (let index = cleanups.length - 1; index >= 0; index -= 1) cleanups[index]?.();
    cleanups = [];
  });

  /**
   * Persist one agent row in the state the case starts from.
   * @param status - Lifecycle status the row carries.
   */
  async function seedAgent(status: MakaioSessionAgent['status']): Promise<void> {
    const now = Date.now();
    await bus.request(AgentStorageSubjects.set, {
      agentId: AGENT_ID,
      agent: {
        agentId: AGENT_ID,
        adapterId: 'live-adapter',
        adapterName: 'test-adapter',
        sessionId: SESSION_ID,
        role: 'lead',
        status,
        createdAt: now,
        lastActivityAt: now,
      },
    });
  }

  /**
   * Issue the fire-and-forget stamp and resolve once storage has answered it.
   *
   * The production call returns `void` by design — a turn must never wait on
   * storage — so the case observes completion through the handler in front of
   * the backend rather than by sleeping.
   * @param status - Activity state the turn reports.
   * @returns A promise that settles when the write has been answered.
   */
  function stamp(status: 'active' | 'idle'): Promise<void> {
    const settled = new Promise<void>((resolve) => {
      const waiting = answered.get(status) ?? [];
      waiting.push(resolve);
      answered.set(status, waiting);
    });
    updateAgentActivityStatusBestEffort(bus, AGENT_ID, status);
    return settled;
  }

  /**
   * Read the stored lifecycle status.
   * @returns The status, or `undefined` when the row is gone.
   */
  async function readStatus(): Promise<string | undefined> {
    const { agent } = await bus.request(AgentStorageSubjects.get, { agentId: AGENT_ID });
    return agent?.status;
  }

  it('moves the row between the two activity states', async () => {
    await seedAgent('idle');

    await stamp('active');
    expect(await readStatus()).toBe('active');

    await stamp('idle');
    expect(await readStatus()).toBe('idle');
  });

  it.each(['starting', 'dead', 'disposed'] as const)('leaves a %s row where the lifecycle put it', async (status) => {
    await seedAgent(status);

    await stamp('active');

    // A turn has nothing to say about a row that is not in the activity domain:
    // `starting` belongs to the start that has not committed yet, `dead` and
    // `disposed` to the teardown that moved it out.
    expect(await readStatus()).toBe(status);
  });

  it('cannot revive a row a retirement compare-and-swapped to dead while the stamp was in flight', async () => {
    await seedAgent('idle');
    let release: (() => void) | undefined;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // The turn stamps `active` and the write is suspended before it reaches
    // storage — the delayed fire-and-forget write this guard exists for.
    const inFlight = stamp('active');

    // Meanwhile the attach whose initial turn failed retires its start: the
    // connector is stopped and the row leaves the activity domain.
    const retired = await bus.request(AgentStorageSubjects.updateStatus, {
      agentId: AGENT_ID,
      status: 'dead',
      expectedStatus: ['idle', 'active'],
    });
    expect(retired.transitioned).toBe(true);

    release?.();
    await inFlight;

    // The row stays where the retirement left it. Unguarded, this write would
    // advertise a live agent behind a stopped connector whose claims are gone.
    expect(await readStatus()).toBe('dead');
  });
});
