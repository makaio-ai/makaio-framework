/**
 * AIAdapter tests — the adapter reserves the provider session it resumes.
 *
 * `adapter.startAgent` has many producers and only one of them reserved. Wave 3
 * (#1140) moves the gate into the shared start handler, where every producer
 * must pass: a `mode: 'resume'` start for a row the **adapter** owns writes a
 * pre-dispatch `starting` row, reserves the provider session, and only then
 * touches the provider.
 *
 * Everything ownership-related runs against the real memory session, agent and
 * ownership backends and the real authority, over one shared state — a stubbed
 * reservation would assert nothing about the seam these cases exist for. The
 * only stubs are the fault injectors, which stand in front of a storage subject
 * to make one round trip fail.
 *
 * Cases 65-68, 90, 94 and 106, plus the Path-C rows of the §5.1 degrade matrix
 * (cases 85 and 86), whose adapter-owned arms Step 2 deferred to here.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import os from 'node:os';
import { MakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  CredentialSubjects,
  SessionOwnershipStorageSubjects,
  SessionSubjects,
  type AdapterSessionClaimRecord,
  type MakaioSessionAgent,
  type ProviderContext,
} from '@makaio/contracts';
import {
  AgentStorageSubjects,
  SessionStorageSubjects,
  createSessionStorageMemoryState,
  registerMemoryAgentStorage,
  registerMemorySessionOwnershipStorage,
  registerMemorySessionStorage,
  registerAdapterSessionMovementObserver,
  registerSessionOwnershipAuthority,
  type SessionStorageMemoryState,
} from '@makaio/services-core/session';
import {
  createTestAdapter,
  MockConnector,
  type BaseAgentConnectorConfig,
  type TestAdapter,
  type TestBus,
} from './shared.js';
import { createManagedAccountTestProviderContext, createNoAuthTestProviderContext } from '../../testing/index.js';

const TEST_PROVIDER_CONTEXT = createNoAuthTestProviderContext('test-config', 'provider-1');
/** A context whose native account the adapter must activate before it starts. */
const MANAGED_PROVIDER_CONTEXT = createManagedAccountTestProviderContext();
const ADAPTER_NAME = 'test-adapter-reserved-start';
const MACHINE_ID = 'reserved-start-machine';
const SESSION_ID = 'reserved-start-session';
const PROVIDER_SESSION = 'native-reserved-start';
/**
 * Key the mock connector confirms, which is deliberately not the one any resume
 * start asks for: a provider may decline the resume and mint its own.
 */
const MOVED_PROVIDER_SESSION = 'mock-adapter-session-id';

/** Connector that runs a per-test hook at the point the provider is first touched. */
class HookedConnector extends MockConnector {
  private readonly onInitialize: (() => Promise<void>) | undefined;

  private readonly confirmedAdapterSessionId: string | undefined;

  public constructor(
    config: BaseAgentConnectorConfig<TestBus> & { adapterId: string },
    onInitialize: (() => Promise<void>) | undefined,
    confirmedAdapterSessionId?: string,
  ) {
    super(config);
    this.onInitialize = onInitialize;
    this.confirmedAdapterSessionId = confirmedAdapterSessionId;
  }

  public override async initialize(): Promise<void> {
    await this.onInitialize?.();
  }

  /**
   * The session the provider committed to, which a case may make differ from the
   * one the start asked to resume — what a provider does when it declines a
   * resume and mints its own.
   * @returns The confirmed provider session.
   */
  public override getConfirmedAdapterSessionId(): string | undefined {
    return this.confirmedAdapterSessionId ?? super.getConfirmedAdapterSessionId();
  }
}

describe('adapter-owned resume starts reserve before they dispatch', () => {
  let adapter: TestAdapter | undefined;
  let cleanups: Array<() => void>;
  let state: SessionStorageMemoryState;
  let connectorsCreated: number;
  let onInitialize: (() => Promise<void>) | undefined;
  /** Session the connector reports as confirmed, when a case overrides it. */
  let confirmedAdapterSessionId: string | undefined;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    state = createSessionStorageMemoryState();
    cleanups = [];
    connectorsCreated = 0;
    onInitialize = undefined;
    confirmedAdapterSessionId = undefined;
  });

  afterEach(async () => {
    await adapter?.closeAsync();
    adapter = undefined;
    for (let index = cleanups.length - 1; index >= 0; index -= 1) cleanups[index]?.();
    cleanups = [];
  });

  /**
   * Register the real session, agent and ownership backends over one state.
   *
   * They share a store because the reservation verifies the agent and session
   * rows it references: registered over separate states every reservation would
   * answer `not-found` instead of deciding.
   */
  function composeStorage(): void {
    cleanups.push(
      registerMemorySessionStorage(MakaioBus, state),
      registerMemoryAgentStorage(MakaioBus, state),
      registerMemorySessionOwnershipStorage(MakaioBus, state),
    );
  }

  /**
   * Compose the real ownership authority this host reserves from.
   * @param machineId - Identity the authority owns claims under, or `undefined`
   *   for the host that has none — the condition case 86 separates from an
   *   absent authority. Never defaulted, so the "no identity" arm cannot be
   *   written as an omission and silently get the identity back.
   */
  function composeAuthority(machineId: string | undefined): void {
    cleanups.push(registerSessionOwnershipAuthority({ bus: MakaioBus, machineId, topology: 'shared-machine' }));
  }

  /** Persist the session row every reservation checks its agent against. */
  async function seedSession(): Promise<void> {
    await MakaioBus.request(SessionStorageSubjects.set, {
      sessionId: SESSION_ID,
      session: {
        sessionId: SESSION_ID,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        status: 'active',
        agents: [],
      },
    });
  }

  /**
   * Create and initialise the adapter under test.
   *
   * The connector counts its own creations, which is how the cases that must
   * dispatch **nothing** assert it: a refusal that still built a connector has
   * already reached the provider.
   */
  async function createAdapter(): Promise<void> {
    ({ adapter } = createTestAdapter(ADAPTER_NAME, {
      connectorFactory: async (config) => {
        connectorsCreated += 1;
        return new HookedConnector(config, onInitialize, confirmedAdapterSessionId);
      },
    }));
    await adapter.init();
  }

  /**
   * Issue an adapter-owned resume start.
   * @param overrides - Fields the case varies (its provider session, mainly)
   * @returns What `startAgent` answered
   */
  async function startResume(overrides?: { adapterSessionId?: string; providerContext?: ProviderContext }) {
    if (adapter === undefined) throw new Error('adapter not created');
    return MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      mode: 'resume',
      sessionId: SESSION_ID,
      adapterSessionId: overrides?.adapterSessionId ?? PROVIDER_SESSION,
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: overrides?.providerContext ?? TEST_PROVIDER_CONTEXT,
    });
  }

  /** @returns Every claim row currently in the store. */
  function claims(): AdapterSessionClaimRecord[] {
    return [...state.claims.values()];
  }

  /** @returns Every agent row currently in the store. */
  function agents(): MakaioSessionAgent[] {
    return [...state.agents.values()];
  }

  /**
   * Take a claim on this adapter's key for an unrelated agent.
   *
   * The honest way to make a key `occupied` and to probe whether it still is:
   * the same storage operation a foreign runtime's reservation would run.
   * @param agentId - Agent the foreign generation belongs to
   * @param providerSessionId - Key to contest
   * @returns What storage answered
   */
  async function foreignClaim(agentId: string, providerSessionId = PROVIDER_SESSION) {
    if (adapter === undefined) throw new Error('adapter not created');
    return MakaioBus.request(SessionOwnershipStorageSubjects.claim, {
      machineId: MACHINE_ID,
      adapterId: adapter.adapterId,
      adapterName: ADAPTER_NAME,
      providerSessionId,
      sessionId: SESSION_ID,
      agentId,
      claimToken: `foreign-token-${agentId}`,
    });
  }

  /**
   * Persist a second agent row a foreign generation can be attached to.
   * @param agentId - Agent to persist
   */
  async function seedForeignAgent(agentId: string): Promise<void> {
    if (adapter === undefined) throw new Error('adapter not created');
    await MakaioBus.request(AgentStorageSubjects.set, {
      agentId,
      agent: {
        agentId,
        adapterId: adapter.adapterId,
        adapterName: ADAPTER_NAME,
        sessionId: SESSION_ID,
        role: 'member',
        status: 'idle',
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
      },
    });
  }

  it('moves its reservation onto the key the connector confirmed, with no turn to carry it', async () => {
    // Path C takes **no settle call of its own** (§4.1): the currency writer is
    // the movement observer. But an observer only runs on an announcement, and
    // an *idle* start emits no agent events — so nothing drives payload
    // enrichment, and the announcement has to come from the start itself.
    //
    // This is the case an earlier round got wrong by asserting the mechanism
    // with a hand-driven announcement instead of the trigger. The connector here
    // confirms its own session rather than the one that was reserved (the mock
    // declines the resume, as a provider can), and nothing else in this case
    // touches the movement seam.
    confirmedAdapterSessionId = MOVED_PROVIDER_SESSION;
    composeStorage();
    composeAuthority(MACHINE_ID);
    cleanups.push(registerAdapterSessionMovementObserver(MakaioBus));
    await seedSession();
    await createAdapter();
    if (adapter === undefined) throw new Error('adapter not created');

    const result = await startResume();

    expect(result).toMatchObject({ success: true, adapterSessionId: MOVED_PROVIDER_SESSION });
    // The row and the claim describe the same provider session. Left to the
    // first turn, an idle agent that never takes one would hold the reserved key
    // for a conversation it is not on while the one it *is* on stays unclaimed —
    // a window with no end, which the next reservation for that key would walk
    // straight through.
    // Origin and currency say different things, and both are right: the row
    // records the session the agent started *from* and never moves, while where
    // the conversation now lives is the ownership seam's to write.
    expect(agents()[0]?.adapterSessionId).toBe(PROVIDER_SESSION);
    expect(agents()[0]?.currentAdapterSessionId).toBe(MOVED_PROVIDER_SESSION);
    const settled = claims();
    expect(settled).toHaveLength(1);
    expect(settled[0]?.providerSessionId).toBe(MOVED_PROVIDER_SESSION);
    expect(settled[0]?.status).toBe('held');
  });

  it('keeps the creation time the pre-dispatch row was written with', async () => {
    composeStorage();
    composeAuthority(MACHINE_ID);
    await seedSession();
    let createdAtWhileStarting: number | undefined;
    onInitialize = async () => {
      createdAtWhileStarting = agents()[0]?.createdAt;
      // A gap the second write would otherwise absorb: without it the two
      // timestamps could coincide and the case would assert nothing.
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    await createAdapter();

    const result = await startResume();

    expect(result.success).toBe(true);
    // A reserved start writes the row twice, and the second write is a whole
    // record. Recomputing the creation time there would date the agent from the
    // moment its connector came up, not from when the start began.
    expect(agents()[0]?.status).toBe('idle');
    expect(agents()[0]?.createdAt).toBe(createdAtWhileStarting);
  });

  it('settles the row of a pre-dispatch write whose response was lost', async () => {
    // The transaction commits and the answer never arrives. Recording the write
    // only *after* it returns would leave the attempt believing it wrote no row,
    // so the cleanup would skip it — and a `starting` row nobody intends to
    // finish is arbitrated over by every later send.
    cleanups.push(
      MakaioBus.on(
        AgentStorageSubjects.set,
        async (ctx) => {
          await ctx.next();
          throw new Error('agent row response was lost after it committed');
        },
        { priority: 100 },
      ),
    );
    composeStorage();
    composeAuthority(MACHINE_ID);
    await seedSession();
    await createAdapter();

    await expect(startResume()).rejects.toThrow('agent row response was lost');

    // Nothing reached the provider, so the row is deleted and the key is free —
    // the pre-dispatch disposition, applied to a row the attempt only knows
    // about because it recorded the write before issuing it.
    expect(connectorsCreated).toBe(0);
    expect(agents()).toHaveLength(0);
    expect(claims()).toHaveLength(0);
  });

  it('case 65: the claim row exists before the provider is touched', async () => {
    composeStorage();
    composeAuthority(MACHINE_ID);
    await seedSession();
    let claimsAtDispatch: AdapterSessionClaimRecord[] = [];
    onInitialize = async () => {
      claimsAtDispatch = claims();
    };
    await createAdapter();

    const result = await startResume();

    expect(result.success).toBe(true);
    // The reservation is committed *before* the connector initialises, which is
    // the whole point of the reordering: a start that dispatched first could
    // find its key taken with a live provider session already behind it.
    expect(claimsAtDispatch).toHaveLength(1);
    expect(claimsAtDispatch[0]?.providerSessionId).toBe(PROVIDER_SESSION);
    expect(claimsAtDispatch[0]?.status).toBe('held');
  });

  it('case 66: an occupied key refuses, dispatches nothing and gives its local claim back', async () => {
    composeStorage();
    composeAuthority(MACHINE_ID);
    await seedSession();
    await createAdapter();
    await seedForeignAgent('foreign-agent');
    expect((await foreignClaim('foreign-agent')).outcome).toBe('claimed');
    const foreignToken = claims()[0]?.claimToken;

    const result = await startResume();

    expect(result).toMatchObject({ success: false, dispatch: 'not-dispatched' });
    expect(connectorsCreated).toBe(0);
    // The pre-dispatch row is deleted, so only the foreign agent survives, and
    // the foreign generation is byte-identical.
    expect(agents().map((agent) => agent.agentId)).toEqual(['foreign-agent']);
    expect(claims()).toHaveLength(1);
    expect(claims()[0]?.claimToken).toBe(foreignToken);

    // A second attempt refuses for the *same* reason. Had the first one kept its
    // process-local claim, this one would have been refused by that instead —
    // which is how the release is asserted without reaching into the registry.
    const second = await startResume();
    expect(second).toMatchObject({ success: false, dispatch: 'not-dispatched' });
    if (second.success) throw new Error('expected a refusal');
    expect(second.message).toContain('was not reserved');
  });

  it('case 67: create, fork and ephemeral starts reserve nothing', async () => {
    composeStorage();
    // No authority: a counting stand-in in its place, so a reservation attempted
    // by any of these modes is observed rather than silently answered.
    let reservations = 0;
    cleanups.push(
      MakaioBus.on(SessionSubjects.ownership.reserveStart, (ctx) => {
        reservations += 1;
        ctx.setResult({ outcome: 'machine-identity-unavailable' });
      }),
    );
    await seedSession();
    await createAdapter();
    if (adapter === undefined) throw new Error('adapter not created');

    const created = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      sessionId: SESSION_ID,
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: TEST_PROVIDER_CONTEXT,
    });
    const forked = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'member',
      mode: 'fork',
      sessionId: SESSION_ID,
      sourceSessionId: SESSION_ID,
      sourceAdapterSessionId: 'source-native-session',
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: TEST_PROVIDER_CONTEXT,
    });
    // A `create` ephemeral start: the only shape the contract permits — the
    // schema refines `ephemeral` to create mode — and the "ping" this exemption
    // exists for. It mints its provider identity inside the provider, so there
    // is no key to reserve and nothing for the exemption to skip past.
    const ephemeral = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'member',
      ephemeral: true,
      sessionId: SESSION_ID,
      initialMessage: 'hello',
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: TEST_PROVIDER_CONTEXT,
    });

    expect(created.success).toBe(true);
    expect(forked.success).toBe(true);
    expect(ephemeral.success).toBe(true);
    expect(reservations).toBe(0);
    expect(claims()).toHaveLength(0);
  });

  it('refuses an ephemeral start that names a provider session to resume', async () => {
    // The invalid combination, dispatched the way a caller that skips validation
    // would produce it. `ephemeral` buys a start the right to skip session and
    // agent storage; reaching the acquisition with a key to resume would let it
    // skip the *reservation* too, and speak to a provider session no generation
    // accounts for. The schema refuses this payload, and so does the layer that
    // would otherwise act on it — an ownership decision may not rest on the
    // validation layer alone.
    composeStorage();
    composeAuthority(MACHINE_ID);
    await seedSession();
    await createAdapter();
    if (adapter === undefined) throw new Error('adapter not created');

    const refused = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'member',
      mode: 'resume',
      ephemeral: true,
      sessionId: SESSION_ID,
      adapterSessionId: 'ephemeral-native-session',
      initialMessage: 'hello',
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: TEST_PROVIDER_CONTEXT,
    });

    expect(refused).toEqual(
      expect.objectContaining({
        success: false,
        dispatch: 'not-dispatched',
        message: expect.stringContaining('ephemeral-native-session'),
      }),
    );
    // Nothing reached the provider and nothing was left behind: no generation,
    // no row, and the local claim it took on the way in is free again.
    expect(claims()).toHaveLength(0);
    expect(agents()).toHaveLength(0);
    const second = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'member',
      mode: 'resume',
      ephemeral: true,
      sessionId: SESSION_ID,
      adapterSessionId: 'ephemeral-native-session',
      initialMessage: 'hello',
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: TEST_PROVIDER_CONTEXT,
    });
    // The *same* refusal, not "already claimed by another in-flight start":
    // that second message would mean the first attempt walked away holding the
    // process-local claim on a key it never owned.
    expect(second).toEqual(expect.objectContaining({ message: expect.stringContaining('may not resume') }));
  });

  it('case 68: a second start for one supplied identity is refused while the first is in flight', async () => {
    // A caller-supplied identity means the *caller* owns the row and reserves,
    // so this case needs no authority — the collision it pins is the adapter's
    // own, and the window it runs in is the one the reserved path widened.
    composeStorage();
    await seedSession();
    let releaseFirst: () => void = () => {};
    const firstEntered = new Promise<void>((resolveEntered) => {
      const suspended = new Promise<void>((resolveSuspended) => {
        releaseFirst = resolveSuspended;
      });
      onInitialize = async () => {
        resolveEntered();
        await suspended;
      };
    });
    await createAdapter();
    if (adapter === undefined) throw new Error('adapter not created');

    const supplied = {
      adapterId: adapter.adapterId,
      agentId: 'caller-minted-agent',
      role: 'lead' as const,
      mode: 'resume' as const,
      sessionId: SESSION_ID,
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: TEST_PROVIDER_CONTEXT,
    };
    const first = MakaioBus.request(AdapterSubjects.startAgent, { ...supplied, adapterSessionId: 'native-first' });
    await firstEntered;

    // Different provider sessions, so the only thing the two starts contend for
    // is the agent identity.
    const second = await MakaioBus.request(AdapterSubjects.startAgent, {
      ...supplied,
      adapterSessionId: 'native-second',
    });
    expect(second).toMatchObject({ success: false, dispatch: 'not-dispatched' });
    if (second.success) throw new Error('expected a refusal');
    expect(second.message).toContain('already registered');

    releaseFirst();
    expect((await first).success).toBe(true);

    // `registry.set` settles the identity claim rather than leaving it pending:
    // once the entry is gone the identity is free again, which it would not be
    // if the claim had outlived the start that took it.
    await MakaioBus.request(AdapterSubjects.stopAgent, { adapterId: adapter.adapterId, agentId: supplied.agentId });
    onInitialize = undefined;
    const third = await MakaioBus.request(AdapterSubjects.startAgent, {
      ...supplied,
      adapterSessionId: 'native-third',
    });
    expect(third.success).toBe(true);
  });

  it('case 90: a reservation that throws leaks nothing', async () => {
    // Registered ahead of the memory backend — request handlers form one chain
    // and the first answers — so the authority's own storage hop is the thing
    // that fails: a composed authority whose storage is broken, not an absent one.
    const faulted = MakaioBus.on(SessionOwnershipStorageSubjects.claim, () => {
      throw new Error('claim storage is down');
    });
    cleanups.push(faulted);
    composeStorage();
    composeAuthority(MACHINE_ID);
    await seedSession();
    await createAdapter();

    await expect(startResume()).rejects.toThrow('claim storage is down');
    expect(connectorsCreated).toBe(0);
    expect(agents()).toHaveLength(0);
    expect(claims()).toHaveLength(0);

    // Both process-local claims are free again: a retry on the same identity
    // key and the same provider session gets through.
    faulted();
    cleanups.splice(cleanups.indexOf(faulted), 1);
    const retry = await startResume();
    expect(retry.success).toBe(true);
  });

  it('case 85/86, Path C: an absent authority fails loudly, a missing machine identity refuses', async () => {
    composeStorage();
    await seedSession();
    await createAdapter();

    // Authority absent — a broken composition, which throws rather than
    // degrading into an unreserved start, and leaves nothing behind.
    await expect(startResume()).rejects.toThrow();
    expect(connectorsCreated).toBe(0);
    expect(agents()).toHaveLength(0);
    expect(claims()).toHaveLength(0);

    // Authority present without a machine identity — a working authority
    // declining to decide a *keyed* reservation, which is a modeled refusal.
    composeAuthority(undefined);
    const refused = await startResume();
    expect(refused).toMatchObject({ success: false, dispatch: 'not-dispatched' });
    if (refused.success) throw new Error('expected a refusal');
    expect(refused.message).toContain('machine-identity-unavailable');
    expect(connectorsCreated).toBe(0);
    expect(agents()).toHaveLength(0);
  });

  it('case 94: the dispatch boundary is the entry of the provider-touching call', async () => {
    composeStorage();
    composeAuthority(MACHINE_ID);
    await seedSession();
    onInitialize = async () => {
      throw new Error('provider refused the resume');
    };
    await createAdapter();

    // (a) A fault *inside* the dispatch: initialization has already spoken to
    // the provider, so the row is kept as `dead` and the key stays taken.
    await expect(startResume()).rejects.toThrow('provider refused the resume');
    expect(agents()).toHaveLength(1);
    expect(agents()[0]?.status).toBe('dead');
    expect(claims()).toHaveLength(1);
    expect(claims()[0]?.status).toBe('abandoned');
    await seedForeignAgent('next-claimant');
    expect((await foreignClaim('next-claimant')).outcome).toBe('already-claimed');
  });

  it('treats a failed account activation as pre-dispatch, not as a touched provider', async () => {
    // Preparing the account is a local account-manager transaction and happens
    // before any connector exists, so a failure there cannot have produced a
    // provider session. Retiring the key for it left the next attempt facing an
    // `occupied` provider session because an account manager was unavailable.
    composeStorage();
    composeAuthority(MACHINE_ID);
    cleanups.push(
      MakaioBus.on(CredentialSubjects.activation.prepare, () => {
        throw new Error('account manager is unavailable');
      }),
    );
    await seedSession();
    await createAdapter();

    // The failure propagates as a throw, as it always has — what changed is the
    // durable state it leaves behind.
    await expect(startResume({ providerContext: MANAGED_PROVIDER_CONTEXT })).rejects.toThrow('could not be activated');

    // Nothing reached the provider, so the row is gone and the key is free for
    // the retry rather than blocked by a generation nothing ever used.
    expect(connectorsCreated).toBe(0);
    expect(agents()).toHaveLength(0);
    expect(claims()).toHaveLength(0);
    await seedForeignAgent('next-claimant');
    expect((await foreignClaim('next-claimant')).outcome).toBe('claimed');
  });

  it('case 94: a fault before the dispatch entry leaves no row and frees the key', async () => {
    // The reservation round trip is the last step before the dispatch entry, so
    // faulting it is the pre-dispatch half of the same boundary. There is no
    // other step in between — which is what makes the two-stage classification
    // total rather than merely exhaustive.
    const faulted = MakaioBus.on(SessionOwnershipStorageSubjects.claim, () => {
      throw new Error('claim storage is down');
    });
    cleanups.push(faulted);
    composeStorage();
    composeAuthority(MACHINE_ID);
    await seedSession();
    await createAdapter();

    await expect(startResume()).rejects.toThrow('claim storage is down');
    expect(agents()).toHaveLength(0);
    expect(claims()).toHaveLength(0);

    faulted();
    cleanups.splice(cleanups.indexOf(faulted), 1);
    await seedForeignAgent('next-claimant');
    expect((await foreignClaim('next-claimant')).outcome).toBe('claimed');
  });

  /**
   * Fail the **post-dispatch** agent-row write of a reserved start.
   *
   * Stands in front of the memory backend and forwards the pre-dispatch write to
   * the shared state, so only the second write — the one that follows
   * registration — fails. That is the write §6.3 stops swallowing: reporting
   * success over an unwritten row leaves it `starting`, and the next send turns
   * that into a second recovery for a live agent.
   * @param mode - Whether the write throws or answers a refusal
   */
  function failSecondAgentRowWrite(mode: 'throw' | 'refuse'): void {
    let writes = 0;
    cleanups.push(
      MakaioBus.on(AgentStorageSubjects.set, (ctx) => {
        writes += 1;
        if (writes === 1) {
          state.agents.set(ctx.payload.agentId, ctx.payload.agent);
          ctx.setResult({ success: true });
          return;
        }
        if (mode === 'throw') throw new Error('agent storage is down');
        ctx.setResult({ success: false });
      }),
    );
  }

  it.each([
    'throw',
    'refuse',
  ] as const)('case 106: a reserved start whose row write %ss after registration fails dispatch-uncertain', async (mode) => {
    failSecondAgentRowWrite(mode);
    composeStorage();
    composeAuthority(MACHINE_ID);
    await seedSession();
    await createAdapter();
    if (adapter === undefined) throw new Error('adapter not created');

    const result = await startResume();

    expect(result).toMatchObject({ success: false, dispatch: 'dispatch-uncertain' });
    // Never `starting` behind a successful response: the row is `dead`, its
    // generation is `abandoned` and the connector is gone.
    expect(agents()).toHaveLength(1);
    expect(agents()[0]?.status).toBe('dead');
    expect(claims()).toHaveLength(1);
    expect(claims()[0]?.status).toBe('abandoned');
    const agentId = agents()[0]?.agentId ?? '';
    expect(adapter.getAgent(agentId)).toBeUndefined();
  });

  it('case 106: an unhandled second write after registration still fails dispatch-uncertain', async () => {
    // The third form, reached where the other two are: *after* the connector is
    // registered. It cannot be staged by a handler that declines — the bus
    // auto-advances past one — so the agent-storage registration is dropped at
    // the provider-touching entry, which is the one point between the two
    // writes. That is also the honest shape of the failure: agent storage went
    // away mid-start.
    cleanups.push(
      registerMemorySessionStorage(MakaioBus, state),
      registerMemorySessionOwnershipStorage(MakaioBus, state),
    );
    const agentStorage = registerMemoryAgentStorage(MakaioBus, state);
    cleanups.push(agentStorage);
    onInitialize = async () => {
      agentStorage();
      await Promise.resolve();
    };
    composeAuthority(MACHINE_ID);
    await seedSession();
    await createAdapter();
    if (adapter === undefined) throw new Error('adapter not created');

    const result = await startResume();

    expect(result).toMatchObject({ success: false, dispatch: 'dispatch-uncertain' });
    // The generation is still given back as `abandoned` — ownership storage is a
    // different registration and is still there — and the connector is gone.
    expect(claims()).toHaveLength(1);
    expect(claims()[0]?.status).toBe('abandoned');
    const agentId = claims()[0]?.agentId ?? '';
    expect(adapter.getAgent(agentId)).toBeUndefined();
    // The row keeps whatever the last reachable write left on it: the subject
    // that would carry `dead` is the very one that vanished. Asserted rather
    // than glossed — the alternative reading, that the cleanup skipped the
    // write, is the defect this case would have to catch.
    expect(agents()[0]?.status).toBe('starting');
  });

  it('case 106: an unhandled agent-storage subject fails a reserved start and leaves nothing', async () => {
    // The third form of the same failure. It is observable at the *pre-dispatch*
    // write, because a host with no agent storage has no row to leave `dead`
    // either — the honest reading of "the row this reservation depends on was
    // never written".
    cleanups.push(
      registerMemorySessionStorage(MakaioBus, state),
      registerMemorySessionOwnershipStorage(MakaioBus, state),
    );
    composeAuthority(MACHINE_ID);
    await seedSession();
    await createAdapter();

    await expect(startResume()).rejects.toThrow('storage:agent.set');
    expect(connectorsCreated).toBe(0);
    expect(claims()).toHaveLength(0);
  });

  it('case 67: an unreserved start still logs and swallows a failing row write', async () => {
    failSecondAgentRowWrite('refuse');
    composeStorage();
    composeAuthority(MACHINE_ID);
    await seedSession();
    await createAdapter();
    if (adapter === undefined) throw new Error('adapter not created');

    // `mode: 'create'` reserves nothing, so its row stays best-effort
    // bookkeeping exactly as before — the behaviour Wave 3 deliberately did not
    // change for the starts it does not gate.
    const result = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      role: 'lead',
      sessionId: SESSION_ID,
      model: 'test-model',
      cwd: os.tmpdir(),
      providerContext: TEST_PROVIDER_CONTEXT,
    });

    expect(result.success).toBe(true);
    expect(claims()).toHaveLength(0);
  });
});
