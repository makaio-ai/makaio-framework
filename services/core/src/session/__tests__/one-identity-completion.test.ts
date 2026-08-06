/**
 * The one-identity completion (#1140 Wave 4 Step 5): cases 208, 214 and 215.
 *
 * An adapter instance ID is derived from `(machineId, adapterName)` and the
 * derivation is one-way, so an act that took its instance from one source and its
 * machine from another files itself under a key nobody else computes — it
 * collides with nothing, so it protects nothing. These cases assert that the two
 * halves are produced together or not at all, and that the acts which follow
 * provably use the pair.
 *
 * Real memory backends, the real ownership authority and the real adapter-runtime
 * identity registry throughout, driven through the real bus. The identity
 * registry in particular is not stubbed: the whole question is which machine an
 * instance was derived for, which a fake derivation would answer by fiat. Only the
 * adapter itself is a stub — it is what the start dispatches *to*, not the seam
 * under test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import {
  AdapterSubjects,
  AgentSubjects,
  SessionOwnershipStorageSubjects,
  SessionSubjects,
  type AdapterSessionClaimRecord,
  type MakaioSessionAgent,
} from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '../../adapter-runtime/namespace.js';
import { buildDeterministicAdapterId, registerAdapterRuntimeIdentityHandlers } from '../../adapter-runtime/identity.js';
import { recoverDeadAgentExclusively } from '../handlers/in-flight-start-join.js';
import { SessionStartError } from '../handlers/session-start-error.js';
import { MakaioSessionService } from '../session-service.js';
import { SessionOrchestrator } from '../session-orchestrator.js';
import { registerMemorySessionEventStorage } from '../session-events/memory-handler.js';
import { designateSessionLead } from '../ownership/lead-designation.js';
import { AgentStorageSubjects } from '../storage/agent-namespace.js';
import { registerMockStorageHandlers } from '../testing/index.js';
import { resolveOwnedAdapterInstance } from '../utils/resolution.js';
import { registerMemorySessionBackends, resetBusHandlers } from './shared.js';

/** Machine this runtime is composed with, and therefore the one it may act for. */
const MACHINE = 'one-identity-own-machine';
/** A machine this runtime is not. */
const FOREIGN_MACHINE = 'one-identity-foreign-machine';
/** The single adapter type every case here uses. */
const ADAPTER = 'one-identity-adapter';
/** The instance `MACHINE` owns — derived, never hand-written, so the pair is real. */
const LOCAL_INSTANCE = buildDeterministicAdapterId(MACHINE, ADAPTER);
/** The instance `FOREIGN_MACHINE` owns; not derivable from `MACHINE`. */
const FOREIGN_INSTANCE = buildDeterministicAdapterId(FOREIGN_MACHINE, ADAPTER);
/** An instance no derivation reproduces — an adapter started under an explicit ID. */
const OPAQUE_INSTANCE = 'explicitly-configured-instance';

describe('one-identity completion', () => {
  let service: MakaioSessionService;
  let cleanups: Array<() => void> = [];
  /** Every `(adapterId, machineId)` pair an ownership act named, in order. */
  let ownershipActs: Array<{ readonly act: string; readonly adapterId: string; readonly machineId?: string }>;
  /** Instances each `adapter.rehydrateAgent` was dispatched to, in order. */
  let rehydrateTargets: string[];
  /** Instances each `adapter.startAgent` was dispatched to, in order. */
  let startTargets: string[];

  beforeEach(async () => {
    resetBusHandlers();
    ownershipActs = [];
    rehydrateTargets = [];
    startTargets = [];
    cleanups = [
      ...registerMemorySessionBackends(MakaioBus),
      registerMemorySessionEventStorage(MakaioBus),
      // The identity registry is omitted alongside the storage backends: these
      // cases ask which machine an instance belongs to, and the mock answers that
      // from a fixed test machine.
      registerMockStorageHandlers({ omit: ['adapter', 'agent', 'session'] }),
      MakaioBus.on(AdapterSubjects.rehydrateAgent, (ctx) => {
        rehydrateTargets.push(ctx.payload.adapterId);
        ctx.setResult({ success: true });
      }),
      MakaioBus.on(AdapterSubjects.stopAgent, (ctx) => {
        ctx.setResult({ success: true, evidence: 'released' });
      }),
      // Observers, not handlers: both acts still reach the real authority.
      MakaioBus.on(
        SessionSubjects.ownership.reserveStart,
        (ctx) => {
          ownershipActs.push({
            act: 'reserve',
            adapterId: ctx.payload.adapterId,
            ...(ctx.payload.machineId !== undefined && { machineId: ctx.payload.machineId }),
          });
          return ctx.next();
        },
        { priority: 1000 },
      ),
      MakaioBus.on(
        SessionSubjects.ownership.settleMovement,
        (ctx) => {
          ownershipActs.push({
            act: 'settle',
            adapterId: ctx.payload.adapterId,
            ...(ctx.payload.machineId !== undefined && { machineId: ctx.payload.machineId }),
          });
          return ctx.next();
        },
        { priority: 1000 },
      ),
    ];
    service = new MakaioSessionService(MakaioBus, { machineId: MACHINE });
    await service.init();
  });

  afterEach(() => {
    service?.destroy();
    for (let index = cleanups.length - 1; index >= 0; index -= 1) cleanups[index]?.();
    cleanups = [];
  });

  /**
   * Register the real adapter-runtime identity handlers.
   *
   * The registry derives `(machineId, adapterName) → adapterId` exactly as
   * production does, and remembers the reverse direction for the instances it has
   * seen — which is why a foreign instance has to *announce* itself here, as one
   * on another host does.
   * @param options - Whether a foreign instance has announced itself.
   */
  function composeAdapterIdentity(options: { readonly announceForeign?: boolean } = {}): void {
    const { registry, cleanup } = registerAdapterRuntimeIdentityHandlers(MakaioBus, {
      currentMachineId: MACHINE,
      knownAdapterNames: [ADAPTER],
    });
    if (options.announceForeign === true) registry.rememberAdapterId(FOREIGN_INSTANCE, ADAPTER);
    cleanups.push(cleanup);
  }

  /**
   * Make the *first* instance resolution unable to answer, then step aside.
   *
   * The framework send path's own deferral is not reachable from production
   * inputs — its recovery plan is fresh-with-history, so its reservation is
   * keyless and can never report `occupied` — which leaves an unresolvable
   * instance as the only producer. Injecting it at priority 100 is how Wave 3
   * reached the same branch, and it is honest here because resolution is not the
   * seam under test in the cases that use it: the inheritance and the reservation
   * key are.
   * @param failures - How many leading resolutions cannot answer.
   */
  function failFirstInstanceResolutions(failures: number): void {
    let remaining = failures;
    cleanups.push(
      MakaioBus.on(
        AdapterRuntimeSubjects.resolveId,
        async (ctx) => {
          if (remaining > 0) {
            remaining -= 1;
            throw new Error(`no instance of ${ctx.payload.adapterName} is resolvable here`);
          }
          await ctx.next();
        },
        { priority: 100 },
      ),
    );
  }

  /**
   * Register the adapter stub a start dispatches into.
   * @param adapterSessionId - Provider session the adapter reports, or `null` for an idle start.
   */
  function registerStartAgent(adapterSessionId: string | null = 'provider-session-1'): void {
    cleanups.push(
      MakaioBus.on(AdapterSubjects.startAgent, (ctx) => {
        startTargets.push(ctx.payload.adapterId);
        ctx.setResult({
          success: true as const,
          agentId: ctx.payload.agentId ?? crypto.randomUUID(),
          adapterId: ctx.payload.adapterId,
          sessionId: ctx.payload.sessionId ?? 'unexpected-session',
          ...(adapterSessionId !== null && { adapterSessionId }),
        });
      }),
    );
  }

  /**
   * Compose the framework orchestrator and swallow the turn routing.
   * @returns Nothing; the orchestrator is torn down with the suite.
   */
  function composeOrchestrator(): void {
    const orchestrator = new SessionOrchestrator(MakaioBus, MACHINE);
    cleanups.push(() => {
      orchestrator.destroy();
    });
    cleanups.push(
      MakaioBus.on(AgentSubjects.sendMessage, (ctx) => {
        ctx.setResult({ messageId: ctx.payload.messageId ?? crypto.randomUUID() });
      }),
    );
  }

  /**
   * Create a session.
   * @param sessionId - Session to create.
   * @returns The created session ID.
   */
  async function seedSession(sessionId: string): Promise<string> {
    await MakaioBus.request(SessionSubjects.create, { sessionId, machineId: MACHINE });
    return sessionId;
  }

  /**
   * Persist one agent row.
   * @param agentId - Agent identity.
   * @param overrides - Row fields this case cares about.
   * @returns A **detached** copy of the row, because the memory store hands out
   *   live objects and an assertion against one it can refresh in place passes
   *   vacuously (Wave 3 round 35's trap).
   */
  async function seedAgent(
    agentId: string,
    overrides: Partial<MakaioSessionAgent> & Pick<MakaioSessionAgent, 'sessionId' | 'adapterId'>,
  ): Promise<MakaioSessionAgent> {
    const now = Date.now();
    const agent: MakaioSessionAgent = {
      agentId,
      adapterName: ADAPTER,
      role: 'lead',
      status: 'dead',
      createdAt: now,
      lastActivityAt: now,
      ...overrides,
    };
    await MakaioBus.request(AgentStorageSubjects.set, { agentId, agent });
    return structuredClone(agent);
  }

  /**
   * Read the claims one machine holds.
   * @param machineId - Machine whose claims are read.
   * @returns The claim rows, as the authority stored them.
   */
  async function loadClaims(machineId: string): Promise<AdapterSessionClaimRecord[]> {
    const { claims } = await MakaioBus.request(SessionOwnershipStorageSubjects.listClaims, { machineId });
    return claims;
  }

  /**
   * Find the modeled start refusal a send raised, through the transport wrapper.
   * @param failure - Whatever the send rejected with.
   * @returns The refusal itself, or `undefined` when nothing raised one.
   */
  function carriedStartError(failure: unknown): SessionStartError | undefined {
    let current: unknown = failure;
    while (current instanceof Error) {
      if (current instanceof SessionStartError) return current;
      current = current.cause;
    }
    return undefined;
  }

  /**
   * Case 214 — the resolver answers with both halves of the key or with neither.
   *
   * `undefined` keeps its Wave-3 meaning: *this runtime may not act for that
   * machine*, never *this failed*. What that costs the caller is the caller's to
   * decide, so the translation is asserted at the two callers that have one.
   */
  describe('resolveOwnedAdapterInstance returns both halves or neither (case 214)', () => {
    it('hands back a caller-named instance together with the machine it was named with', async () => {
      composeAdapterIdentity({ announceForeign: true });

      const owned = await resolveOwnedAdapterInstance(MakaioBus, {
        adapterName: ADAPTER,
        adapterId: FOREIGN_INSTANCE,
        machineId: FOREIGN_MACHINE,
      });

      // Returned as named rather than re-derived: the caller already holds both
      // halves from one source, and this runtime has nothing to add to a pair it
      // did not compute.
      expect(owned).toEqual({ adapterId: FOREIGN_INSTANCE, machineId: FOREIGN_MACHINE });
    });

    it('refuses a named instance whose machine was not named', async () => {
      composeAdapterIdentity();

      const owned = await resolveOwnedAdapterInstance(MakaioBus, {
        adapterName: ADAPTER,
        adapterId: FOREIGN_INSTANCE,
      });

      // The handler-side half of the schema's refinement, and it is load-bearing
      // rather than redundant: the bus this test drives does not validate
      // payloads, which is exactly the composition a schema alone does not cover.
      expect(owned).toBeUndefined();
    });

    it('derives the instance for a named machine and echoes that machine back', async () => {
      composeAdapterIdentity();

      const owned = await resolveOwnedAdapterInstance(MakaioBus, {
        adapterName: ADAPTER,
        machineId: MACHINE,
        storedAdapterId: OPAQUE_INSTANCE,
      });

      // One call, one identity: the machine that went in is the machine that
      // comes out, alongside the instance derived for it — and the stored
      // instance is *not* the answer even though one was offered.
      expect(owned).toEqual({ adapterId: LOCAL_INSTANCE, machineId: MACHINE });
    });

    it('refuses rather than fall back on the stored instance when a machine was named', async () => {
      composeAdapterIdentity();
      failFirstInstanceResolutions(1);

      const owned = await resolveOwnedAdapterInstance(MakaioBus, {
        adapterName: ADAPTER,
        machineId: MACHINE,
        storedAdapterId: OPAQUE_INSTANCE,
      });

      // The stored instance may not stand in: the machine it belongs to cannot be
      // recovered from it, so pairing it with the named machine would produce the
      // mixed key silently — and precisely in the moment the lookup that could
      // have proven the pair was unavailable.
      expect(owned).toBeUndefined();
    });

    it('falls back on the stored instance when no machine was named, because there is none to mix', async () => {
      composeAdapterIdentity();
      failFirstInstanceResolutions(1);

      const owned = await resolveOwnedAdapterInstance(MakaioBus, {
        adapterName: ADAPTER,
        storedAdapterId: OPAQUE_INSTANCE,
      });

      // The unscoped form, and the asymmetry with the arm above is the whole
      // point: an attempt that names no machine is unscoped in *every* act, so
      // the stored instance cannot file anything in a second namespace. The
      // answer carries no machine either — it never had one to carry.
      expect(owned).toEqual({ adapterId: OPAQUE_INSTANCE });
    });

    it('translates the refusal into a deferral at the send path', async () => {
      composeAdapterIdentity();
      failFirstInstanceResolutions(1);
      const sessionId = await seedSession('one-identity-send-defers');
      const agent = await seedAgent('send-deferred-agent', { sessionId, adapterId: OPAQUE_INSTANCE });

      const recovered = await recoverDeadAgentExclusively(MakaioBus, agent, {
        resumeProviderSessionId: null,
        machineId: MACHINE,
      });

      expect(recovered.deferred).toBe(true);
      // Nothing was addressed at all — no dispatch, and therefore no ownership
      // act in a namespace this runtime could not have derived.
      expect(rehydrateTargets).toEqual([]);
      expect(ownershipActs).toEqual([]);
    });

    it('translates the refusal into a non-native report at the restart path', async () => {
      composeAdapterIdentity();
      // Everything a **native** restart needs is in place — the adapter declares
      // `session:resume`, the session belongs to this machine and the agent has
      // resumable currency — so the only thing that can stop the native dispatch
      // is the refusal itself. Without that, this arm would be green against a
      // restart that degraded for an unrelated reason.
      cleanups.push(
        MakaioBus.on(AdapterSubjects.getCapabilities, (ctx) => {
          ctx.setResult({ capabilities: ['session:resume'], nativeTools: [] });
        }),
      );
      failFirstInstanceResolutions(1);
      const sessionId = await seedSession('one-identity-restart-reports');
      await seedAgent('restart-deferred-agent', {
        sessionId,
        adapterId: OPAQUE_INSTANCE,
        status: 'idle',
        adapterSessionId: 'provider-restart-target',
      });

      const { results } = await MakaioBus.request(SessionSubjects.restartAgents, { sessionId });

      // Success, and the *stored* instance in the report: nothing was dispatched,
      // so re-stamping the row with a freshly resolved instance would advertise a
      // binding that does not exist. The send path recovers the agent later with
      // injected history, which is what makes this a report and not a failure.
      expect(results).toEqual([{ agentId: 'restart-deferred-agent', adapterId: OPAQUE_INSTANCE, success: true }]);
      expect(rehydrateTargets).toEqual([]);
      expect(ownershipActs).toEqual([]);
    });

    it('files a recovery under exactly the pair one call produced', async () => {
      composeAdapterIdentity();
      const sessionId = await seedSession('one-identity-recovery-pair');
      const agent = await seedAgent('recovered-agent', { sessionId, adapterId: OPAQUE_INSTANCE });

      const recovered = await recoverDeadAgentExclusively(MakaioBus, agent, {
        resumeProviderSessionId: null,
        machineId: MACHINE,
      });

      expect(recovered.deferred).toBe(false);
      // The reservation names the machine the instance was derived for, and the
      // dispatch names that same instance — the stale stored one appears nowhere.
      expect(ownershipActs).toEqual([{ act: 'reserve', adapterId: LOCAL_INSTANCE, machineId: MACHINE }]);
      expect(rehydrateTargets).toEqual([LOCAL_INSTANCE]);
    });
  });

  /**
   * Case 208 — no keyed settlement occurs without a machine.
   *
   * A fresh lead start reserves **keyless**, which cannot reveal an absent
   * machine, and then settles on the provider session its connector confirmed,
   * which is keyed and can. Wave 3 left that settlement outside its degrade
   * matrix whenever the caller named an instance, because the machine was
   * unrecoverable from the ID. The machine now travels with the instance, so the
   * case leaves the matrix by construction.
   */
  describe('no keyed settlement without a machine (case 208)', () => {
    it('settles a caller-named instance under the machine it was named with', async () => {
      composeAdapterIdentity({ announceForeign: true });
      composeOrchestrator();
      registerStartAgent('provider-named-instance');
      const sessionId = await seedSession('one-identity-named-instance');

      await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        message: 'start on a named instance',
        agent: { kind: 'adapter', adapterId: FOREIGN_INSTANCE, machineId: FOREIGN_MACHINE },
      });

      // Both acts of the start name one identity — the keyless reservation and
      // the keyed settlement — and it is the identity the caller named, not this
      // runtime's own.
      expect(ownershipActs).toEqual([
        { act: 'reserve', adapterId: FOREIGN_INSTANCE, machineId: FOREIGN_MACHINE },
        { act: 'settle', adapterId: FOREIGN_INSTANCE, machineId: FOREIGN_MACHINE },
      ]);
      expect(startTargets).toEqual([FOREIGN_INSTANCE]);
      // Read out of storage rather than inferred from the payload: the claim the
      // settlement wrote is in the named machine's namespace, which is where the
      // runtime that owns that instance looks — the whole purpose of the key.
      const foreignClaims = await loadClaims(FOREIGN_MACHINE);
      expect(foreignClaims.map((claim) => claim.providerSessionId)).toEqual(['provider-named-instance']);
      expect(await loadClaims(MACHINE)).toEqual([]);
    });

    it('settles an unnamed instance under this runtime own machine', async () => {
      composeAdapterIdentity();
      composeOrchestrator();
      registerStartAgent('provider-own-instance');
      const sessionId = await seedSession('one-identity-own-instance');

      await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        message: 'start on the local instance',
        agent: { kind: 'adapter', adapterName: ADAPTER },
      });

      // The other shape, and the assertion is the same one: a machine, named in
      // both acts. There is no shape of this path left in which the settlement is
      // keyed and the machine is absent, which is what makes the matrix total.
      expect(ownershipActs).toEqual([
        { act: 'reserve', adapterId: LOCAL_INSTANCE, machineId: MACHINE },
        { act: 'settle', adapterId: LOCAL_INSTANCE, machineId: MACHINE },
      ]);
      const claims = await loadClaims(MACHINE);
      expect(claims.map((claim) => claim.providerSessionId)).toEqual(['provider-own-instance']);
    });

    it('refuses a start that named an instance without its machine, before it can settle anything', async () => {
      composeAdapterIdentity({ announceForeign: true });
      composeOrchestrator();
      registerStartAgent('provider-never-reached');
      const sessionId = await seedSession('one-identity-half-named');

      // A payload the schema forbids, dispatched over a bus that does not
      // validate — the composition in which only a handler-side refusal exists.
      const failure = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        message: 'start on half an identity',
        agent: { kind: 'adapter', adapterId: FOREIGN_INSTANCE },
      }).catch((error: unknown) => error);

      expect(carriedStartError(failure)?.code).toBe('start-failed');
      // Refused *before* the dispatch, so there is no connector, no keyed
      // settlement and nothing in any machine's namespace to reconcile.
      expect(startTargets).toEqual([]);
      expect(ownershipActs).toEqual([]);
      expect(await loadClaims(MACHINE)).toEqual([]);
      expect(await loadClaims(FOREIGN_MACHINE)).toEqual([]);
    });

    it('refuses a start that named a machine without an instance, rather than starting on this one', async () => {
      composeAdapterIdentity({ announceForeign: true });
      composeOrchestrator();
      registerStartAgent('provider-never-reached');
      const sessionId = await seedSession('one-identity-half-named-machine');

      // The other half of the schema's symmetry, over the same non-validating bus.
      // This shape had the worse silent outcome of the two: the branch a selection
      // without an instance takes derives for *this* runtime's machine, so the
      // caller's machine was read by nothing and the agent started here.
      const failure = await MakaioBus.request(SessionSubjects.sendMessage, {
        sessionId,
        message: 'start on a machine and no instance',
        agent: { kind: 'adapter', adapterName: ADAPTER, machineId: FOREIGN_MACHINE },
      }).catch((error: unknown) => error);

      expect(carriedStartError(failure)?.code).toBe('start-failed');
      // Nothing dispatched anywhere — least of all to the local instance, which is
      // where the ignored machine used to land.
      expect(startTargets).toEqual([]);
      expect(ownershipActs).toEqual([]);
      expect(await loadClaims(MACHINE)).toEqual([]);
      expect(await loadClaims(FOREIGN_MACHINE)).toEqual([]);
    });
  });

  /**
   * Case 215 — the replacement lead inherits the machine with the instance.
   *
   * Wave 3 rejected inheriting `adapterId` alone as the mixed key. What makes the
   * inheritance honest is not a new field on the row — the row still names no
   * machine — but the forward direction of the derivation: a *candidate* machine
   * can be checked against the instance the row names, and a match proves the
   * pair. The check is one-directional, so a mismatch falls back to the
   * documented local substitution instead of refusing.
   *
   * Asserted on the resulting reservation's key rather than on the selection
   * object, because the key is what another actor computes and compares.
   */
  describe('the replacement lead inherits the machine with the instance (case 215)', () => {
    /**
     * Seed a session whose lead is dead and drive the send that replaces it.
     * @param leadAdapterId - Instance the dead lead's row names.
     * @param resolutionFailures - How many leading instance resolutions cannot answer.
     * @returns The session the send ran against.
     */
    async function sendAgainstDeferredLead(leadAdapterId: string, resolutionFailures: number): Promise<string> {
      const sessionId = await seedSession(`one-identity-replacement-${leadAdapterId}`);
      await seedAgent('deferred-lead', { sessionId, adapterId: leadAdapterId, model: 'inherited-model' });
      // Designated through the ownership seam that owns the column, not by a
      // whole-record write: the designation is a compare-and-swap and the session
      // row deliberately has no other writer for it.
      await designateSessionLead(MakaioBus, {
        sessionId,
        agentId: 'deferred-lead',
        expectedLeadAgentId: null,
      });
      cleanups.push(
        MakaioBus.on(AdapterSubjects.getAgent, (ctx) => {
          ctx.setResult({ agent: null }); // the lead's connector is gone
        }),
      );
      composeAdapterIdentity({ announceForeign: true });
      failFirstInstanceResolutions(resolutionFailures);
      composeOrchestrator();
      registerStartAgent('provider-replacement');
      await MakaioBus.request(SessionSubjects.sendMessage, { sessionId, message: 'continue the conversation' });
      return sessionId;
    }

    it('reserves the replacement on the inherited instance, in the machine that provably owns it', async () => {
      // Two resolutions fail: the recovery's, which is what defers the lead, and
      // one more that the replacement would need **if** it had to resolve a name.
      // It does not, because it inherited a proven pair — which is what this arm
      // asserts and what a name-only inheritance could not satisfy.
      const sessionId = await sendAgainstDeferredLead(LOCAL_INSTANCE, 2);

      expect(ownershipActs).toEqual([
        { act: 'reserve', adapterId: LOCAL_INSTANCE, machineId: MACHINE },
        { act: 'settle', adapterId: LOCAL_INSTANCE, machineId: MACHINE },
      ]);
      expect(startTargets).toEqual([LOCAL_INSTANCE]);
      // A replacement *agent*, continuing the same conversation on the same
      // instance — the degrade replaces the agent, not the machine. The deferred
      // row itself stays: this runtime may not drive it, which is not the same as
      // being entitled to delete it.
      const { session } = await MakaioBus.request(SessionSubjects.get, { sessionId });
      const replacement = session?.agents.find((agent) => agent.agentId === session.leadAgentId);
      expect(replacement?.agentId).not.toBe('deferred-lead');
      expect(replacement?.model).toBe('inherited-model');
      expect(replacement?.adapterId).toBe(LOCAL_INSTANCE);
    });

    it('substitutes a local instance when the caller machine does not provably own the named one', async () => {
      // The one-directional half. `FOREIGN_INSTANCE` is not derivable from this
      // runtime's machine, so inheriting it would be the mixed key Wave 3
      // rejected; the replacement resolves the adapter *type* on the machine it
      // can act for instead.
      await sendAgainstDeferredLead(FOREIGN_INSTANCE, 1);

      expect(ownershipActs).toEqual([
        { act: 'reserve', adapterId: LOCAL_INSTANCE, machineId: MACHINE },
        { act: 'settle', adapterId: LOCAL_INSTANCE, machineId: MACHINE },
      ]);
      expect(startTargets).toEqual([LOCAL_INSTANCE]);
      expect(await loadClaims(FOREIGN_MACHINE)).toEqual([]);
    });
  });
});
