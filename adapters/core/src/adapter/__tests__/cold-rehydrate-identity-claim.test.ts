/**
 * Case 204g — a cold rehydrate's agent-identity claim is released on every exit.
 *
 * Without the claim, "nothing here" was answerable for an agent a cold rehydrate is
 * about to resurrect, and a teardown answering it would report "provably nothing
 * speaking" about a connector arriving one await later. With it, the failure mode
 * inverts: a **leaked** claim makes the agent permanently un-stoppable, which is
 * worse than the window the claim closes. So every row of the exit matrix is driven,
 * and each asserts the same thing — the claim is free afterwards.
 *
 * The claim is probed the way a real caller would notice it: by re-acquiring it. A
 * second rehydrate that answers "already claimed by another in-flight start or
 * rehydrate" is a leak; anything else is not.
 */
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, CredentialSubjects } from '@makaio/contracts';
import type { MakaioSessionAgent } from '@makaio/contracts';
import {
  AgentStorageSubjects,
  createSessionStorageMemoryState,
  registerMemoryAgentStorage,
  type SessionStorageMemoryState,
} from '@makaio/services-core/session';
import type { BaseAgentConnectorConfig } from '../../agent/types.js';
import { createTestAdapter, MockConnector, registerStartReservationAuthority, type TestAdapter } from './shared.js';

const AGENT_ID = 'agent-cold';
const SESSION_ID = 'session-cold';
/** The one refusal that means the claim leaked. */
const CLAIM_DENIED = 'already claimed by another in-flight start or rehydrate';

let state: SessionStorageMemoryState;
let adapter: TestAdapter;
let initializeFailure: Error | undefined;
let connectorFactoryFailure: Error | undefined;
// Bound from the adapter the factories above are wired into; the config factory
// runs only after construction, so the late binding is safe.
let coldScopedBus: BaseAgentConnectorConfig['bus'];
const cleanups: Array<() => void> = [];

/** A connector generation whose initialization the test can fail. */
class ColdConnector extends MockConnector {
  /** Fail initialization, which is the cold path's last provider-touching step. */
  public override async initialize(): Promise<void> {
    if (initializeFailure !== undefined) throw initializeFailure;
  }
}

beforeEach(async () => {
  state = createSessionStorageMemoryState();
  initializeFailure = undefined;
  connectorFactoryFailure = undefined;
  cleanups.push(registerMemoryAgentStorage(MakaioBus, state), registerStartReservationAuthority());
  ({ adapter } = createTestAdapter('cold-adapter', {
    // The default factory drops `adapterSessionId`, which would leave every entry
    // occupying nothing and make the session-claim arm below vacuous.
    configFactory: async (input) => ({
      bus: coldScopedBus,
      agentId: input.agentId ?? AGENT_ID,
      adapterId: input.adapterId ?? adapter.adapterId,
      adapterName: 'cold-adapter',
      model: input.model ?? 'test-model',
      cwd: input.cwd ?? os.tmpdir(),
      ...(input.adapterSessionId !== undefined && { adapterSessionId: input.adapterSessionId }),
    }),
    connectorFactory: (config) => {
      if (connectorFactoryFailure !== undefined) throw connectorFactoryFailure;
      return new ColdConnector(config);
    },
  }));
  coldScopedBus = adapter['adapterBus'];
  await adapter.init();
});

afterEach(async () => {
  await adapter.closeAsync();
  cleanups.splice(0).forEach((cleanup) => cleanup());
  MakaioBus.__resetHandlers?.();
});

/**
 * Store one rehydratable agent row.
 * @param overrides - Fields to override on the seeded row
 */
async function seedAgentRow(overrides: Partial<MakaioSessionAgent> = {}): Promise<void> {
  await MakaioBus.request(AgentStorageSubjects.set, {
    agentId: AGENT_ID,
    agent: {
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
      adapterId: adapter.adapterId,
      adapterName: 'cold-adapter',
      role: 'lead',
      model: 'test-model',
      cwd: os.tmpdir(),
      status: 'idle',
      adapterSessionId: 'stored-provider-session',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      ...overrides,
    },
  });
}

/**
 * Issue one cold rehydrate.
 * @param resumeAdapterSessionId - Provider session to resume, when the arm needs one
 * @returns The rehydrate response
 */
function rehydrate(resumeAdapterSessionId?: string): Promise<{ success: boolean; message?: string }> {
  return MakaioBus.request(AdapterSubjects.rehydrateAgent, {
    adapterId: adapter.adapterId,
    agentId: AGENT_ID,
    ...(resumeAdapterSessionId !== undefined && { resumeAdapterSessionId }),
  });
}

/**
 * Prove the identity claim is free by taking it again.
 *
 * A second rehydrate is the real re-acquisition: it runs the same
 * `claimAgentIdentity` the first one ran, so a leaked claim is refused here and
 * nowhere else.
 * @returns Whatever the second rehydrate answered
 */
async function reacquire(): Promise<{ success: boolean; message?: string }> {
  return rehydrate().catch((error: unknown) => ({
    success: false,
    message: error instanceof Error ? error.message : String(error),
  }));
}

describe('case 204g: every exit leaves the identity claim free', () => {
  it('arm 1: a preflight refusal releases it', async () => {
    // No stored row at all — the first thing the preflight reads.
    const first = await rehydrate();
    expect(first.success).toBe(false);

    const second = await reacquire();
    expect(second.message ?? '').not.toContain(CLAIM_DENIED);
  });

  it('arm 1b: the disposed refusal releases it too', async () => {
    // The other preflight refusal, and the one a consumer hits after a real
    // teardown: `disposed` is terminal, so this exit is permanent and a claim
    // leaked here would never be given back.
    await seedAgentRow({ status: 'disposed' });

    const first = await rehydrate();
    expect(first.success).toBe(false);

    const second = await reacquire();
    expect(second.message ?? '').not.toContain(CLAIM_DENIED);
  });

  it('arm 2: a provider-context activation refusal releases it, and it is re-acquirable', async () => {
    // The exit the enumerated list missed: activation sits between the
    // adapter-session claim and agent creation, and its own catch releases only the
    // *adapter-session* claim.
    await seedAgentRow({ providerConfigId: 'provider-config-1' });
    cleanups.push(
      MakaioBus.on(CredentialSubjects.activation.prepare, (ctx) => {
        ctx.setResult({ success: false, code: 'activation-failed' });
      }),
    );

    const first = await rehydrate('stored-provider-session');
    expect(first.success).toBe(false);

    const second = await reacquire();
    expect(second.message ?? '').not.toContain(CLAIM_DENIED);
  });

  it('arm 3: an agent-create failure releases it', async () => {
    await seedAgentRow();
    connectorFactoryFailure = new Error('connector factory refused');

    const first = await rehydrate().catch(() => ({ success: false, message: undefined }));
    expect(first.success).toBe(false);

    const second = await reacquire();
    expect(second.message ?? '').not.toContain(CLAIM_DENIED);
  });

  it('arm 4: an agent-init failure releases it', async () => {
    await seedAgentRow();
    initializeFailure = new Error('connector initialization refused');

    const first = await rehydrate().catch(() => ({ success: false, message: undefined }));
    expect(first.success).toBe(false);

    const second = await reacquire();
    expect(second.message ?? '').not.toContain(CLAIM_DENIED);
  });

  it('arm 5: an adapter-session-claim failure releases it', async () => {
    await seedAgentRow();
    // A concurrent holder of the provider session, so the resume claim is denied
    // before anything else happens.
    const held = 'contested-provider-session';
    const started = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'resume',
      sessionId: SESSION_ID,
      adapterSessionId: held,
    });
    expect(started.success).toBe(true);
    const listed = await MakaioBus.request(AdapterSubjects.listAgents, { adapterId: adapter.adapterId });
    expect(listed.agents.map((entry) => entry.adapterSessionId)).toContain(held);

    const first = await rehydrate(held);
    expect(first.success).toBe(false);
    expect(first.message ?? '').toContain('already claimed');

    // The *identity* claim is still free even though the *session* claim was the
    // one refused — two claims, one release matrix.
    const second = await reacquire();
    expect(second.message ?? '').not.toContain(CLAIM_DENIED);
  });

  it('arm 6: success settles it through `registry.set`', async () => {
    await seedAgentRow();

    const first = await rehydrate();
    expect(first.success).toBe(true);

    // The claim was settled by the registration, not released by the `finally`: the
    // agent is now registered, so a second rehydrate takes the **warm** path and
    // succeeds rather than being refused as claimed.
    const second = await reacquire();
    expect(second.success).toBe(true);
    expect(second.message ?? '').not.toContain(CLAIM_DENIED);
  });
});
