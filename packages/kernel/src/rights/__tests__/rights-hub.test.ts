import { leaseNamespace } from '@makaio/bus-core/kernel-api';
import { describe, expect, it, vi } from 'vitest';
import {
  createBusInstance,
  ForeignOwnContextError,
  InvalidCallContextError,
  NoHandlerError,
  ValidationError,
} from '@makaio/bus-core';
import type { BusMessage, BusReceiveHandler, BusResponseMessage, BusTransport, IMakaioBus } from '@makaio/bus-core';
import { createCarrierBus, mintCallContext } from '@makaio/bus-core/kernel-api';
import { MAKAIO_EXTENSION_PARTY_KIND } from '@makaio/core';
import type { CallContext, ExtensionName, Party, PartyRef } from '@makaio/core';
import { AccessDeniedError, AccessSubjects, CoreDenialPlace } from '@makaio/contracts/access';
import type { AccessDenied } from '@makaio/contracts/access';
import type { JsonSchema, JsonValue } from '@makaio/contracts/shared';
import {
  RightDenialReason,
  RightsNamespace,
  RightsSubjects,
  SUBJECT_HANDLE_RIGHT,
  SUBJECT_SEND_RIGHT,
  SUBJECT_SUBSCRIBE_RIGHT,
} from '@makaio/contracts/rights';
import type {
  RightAnswer,
  RightFromData,
  RightName,
  RightQuestion,
  RightSourceQuestion,
  RightsCapability,
  RightsChanged,
  RightsSourceContribution,
} from '@makaio/contracts/rights';
import { createRightsHub } from '../rights-hub.js';
import type { RightsHub } from '../rights-hub.js';
import { CORE_RIGHTS_OWNER } from '../rights-directory.js';
import { registerRightsHandlers } from '../rights-handlers.js';
import type { KernelMakaioExtension } from '../../extension/types.js';
import { collectInto, createAnswerSource } from './fixtures.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const CALLER: Party = { kind: 'acme.user', id: 'u1' };
const PRINCIPAL: Party = { kind: 'acme.user', id: 'p1' };
const ATTESTER: Party = { kind: 'acme.idp', id: 'a1' };

/** Waits one macrotask turn, long enough for a fire-and-forget `bus.emit` to settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * The carrier a `capabilityFor(owner, carrier)` capability is bound to, matching
 * `extensionCarrierOf` in `extension-context-builder.ts`: kind `makaio.extension`, id the owner.
 * @param owner - Extension name.
 * @returns The carrier `PartyRef`.
 */
function carrierFor(owner: ExtensionName): PartyRef {
  return { kind: MAKAIO_EXTENSION_PARTY_KIND, id: owner };
}

/**
 * Builds a minimal {@link KernelMakaioExtension} for processor tests.
 * @param name - Extension name (also used as the display name).
 * @param overrides - Fields to add, typically `rights` and/or `rightsSources`.
 * @returns The extension manifest.
 */
function testExtensionPkg(name: string, overrides: Partial<KernelMakaioExtension> = {}): KernelMakaioExtension {
  return { name, displayName: name, version: '0.1.0', ...overrides };
}

/**
 * Begins an activation attempt for `owner`, binds its capability, stages one data
 * right through it, then calls `hub.activate` so the right becomes visible. The
 * one path every capability test that needs an already `active` owner shares,
 * rather than repeating the three calls inline.
 * @param hub - Hub the owner activates against.
 * @param owner - Extension name.
 * @param right - The one right to stage and commit for `owner`.
 * @returns The capability, bound to `owner`'s own carrier, already `active`.
 */
function activateWithRight(hub: RightsHub, owner: ExtensionName, right: RightName): RightsCapability {
  hub.beginActivation(owner);
  const capability = hub.capabilityFor(owner, carrierFor(owner));
  capability.declareRightsFromData([{ right, description: 'd', context: {} }]);
  hub.activate(owner, testExtensionPkg(owner));
  return capability;
}

// ---------------------------------------------------------------------------
// 1. Capability
// ---------------------------------------------------------------------------

describe('RightsHub: capability', () => {
  const RIGHT: RightName = 'ext.a.thing';

  function freshHub(): { hub: RightsHub; bus: IMakaioBus } {
    const bus = createBusInstance();
    return { hub: createRightsHub({ bus }), bus };
  }

  it('capabilityFor(owner, carrier).resolve(call, { right, context }) resolves once active', async () => {
    const { hub } = freshHub();
    const capability = activateWithRight(hub, 'ext.a', RIGHT);
    const call = mintCallContext({ caller: CALLER, principal: CALLER });

    await expect(capability.resolve(call, { right: RIGHT, context: {} })).resolves.toEqual({ granted: true });
  });

  it('rejects a malformed ask carrying an extra key', async () => {
    const { hub } = freshHub();
    const capability = activateWithRight(hub, 'ext.a', RIGHT);
    const call = mintCallContext({ caller: CALLER, principal: CALLER });
    const malformedAsk = { right: RIGHT, context: {}, extra: 'nope' };

    await expect(capability.resolve(call, malformedAsk)).rejects.toThrow();
  });

  it('registerRightsSource then resolve is denied when the source says no', async () => {
    const { hub } = freshHub();
    const capability = activateWithRight(hub, 'ext.a', RIGHT);
    capability.registerRightsSource(createAnswerSource('ext.a.src', [RIGHT], { kind: 'deny', reason: 'nope' }));
    const call = mintCallContext({ caller: CALLER, principal: CALLER });

    await expect(capability.resolve(call, { right: RIGHT, context: {} })).resolves.toEqual({
      granted: false,
      reason: 'nope',
      by: 'ext.a.src',
    });
  });

  it('sourceChanged drops cached answers of every right the source pattern covers', async () => {
    const { hub } = freshHub();
    const name = 'ext.a';
    hub.beginActivation(name);
    const capability = hub.capabilityFor(name, carrierFor(name));
    capability.declareRightsFromData([
      { right: 'ext.a.r1', description: 'd', context: {} },
      { right: 'ext.a.r2', description: 'd', context: {} },
    ]);
    hub.activate(name, testExtensionPkg(name));
    const source = createAnswerSource('ext.a.src', ['ext.a.*'], { kind: 'grant' }, ['ext.a.*']);
    capability.registerRightsSource(source);
    const call = mintCallContext({ caller: CALLER, principal: CALLER });

    await capability.resolve(call, { right: 'ext.a.r1', context: {} });
    await capability.resolve(call, { right: 'ext.a.r1', context: {} });
    await capability.resolve(call, { right: 'ext.a.r2', context: {} });
    expect(source.calls).toHaveLength(2);

    capability.sourceChanged('ext.a.src');

    await capability.resolve(call, { right: 'ext.a.r1', context: {} });
    await capability.resolve(call, { right: 'ext.a.r2', context: {} });
    expect(source.calls).toHaveLength(4);
  });

  it('rejects a call context rebuilt by spreading a real one onto a plain object: never minted', async () => {
    const { hub } = freshHub();
    const capability = activateWithRight(hub, 'ext.a', RIGHT);
    const realCall = mintCallContext({ caller: CALLER, principal: CALLER });
    const other: Party = { kind: 'acme.user', id: 'other' };
    const forged = Object.assign({}, realCall, { caller: other, principal: other });

    await expect(capability.resolve(forged, { right: RIGHT, context: {} })).rejects.toThrow(InvalidCallContextError);
  });

  it("rejects the host bus's own context: its carrier is the host, not the capability's owner", async () => {
    const { hub, bus } = freshHub();
    const capability = activateWithRight(hub, 'ext.a', RIGHT);

    await expect(capability.resolve(bus.own('observer'), { right: RIGHT, context: {} })).rejects.toThrow(
      ForeignOwnContextError,
    );
  });

  it("rejects the own context of another extension's carrier", async () => {
    const { hub, bus } = freshHub();
    const capability = activateWithRight(hub, 'ext.a', RIGHT);
    const busOther = createCarrierBus(bus, carrierFor('ext.other'));

    await expect(capability.resolve(busOther.own('start'), { right: RIGHT, context: {} })).rejects.toThrow(
      ForeignOwnContextError,
    );
  });

  it("accepts a received call obtained inside a request handler on the owner's own carrier bus", async () => {
    const { hub, bus } = freshHub();
    leaseNamespace(bus, RightsNamespace, { kind: 'host' });
    const capability = activateWithRight(hub, 'ext.a', RIGHT);
    const busA = createCarrierBus(bus, carrierFor('ext.a'));
    const cleanup = busA.on(RightsSubjects.resolve, async (ctx) => {
      ctx.setResult(await capability.resolve(ctx.call, ctx.payload));
    });
    const busOther = createCarrierBus(bus, carrierFor('ext.other'));

    const result = await busOther.request(busOther.own('shared-work'), RightsSubjects.resolve, {
      right: RIGHT,
      context: {},
    });

    expect(result).toEqual({ granted: true });
    cleanup();
  });
});

// ---------------------------------------------------------------------------
// 2. makaio:rights.changed
// ---------------------------------------------------------------------------

describe('RightsHub: makaio:rights.changed', () => {
  it('stages silently while pending and announces owner, an increasing revision, rights and the reason once active', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const changes: RightsChanged[] = [];
    bus.on(RightsSubjects.changed, (ctx) => {
      changes.push(ctx.payload);
    });
    const name = 'ext.c';
    hub.beginActivation(name);
    const capability = hub.capabilityFor(name, carrierFor(name));

    capability.declareRightsFromData([{ right: 'ext.c.r1', description: 'd', context: {} }]);
    await flush();
    expect(changes).toEqual([]);

    hub.activate(name, testExtensionPkg(name));
    capability.registerRightsSource(createAnswerSource('ext.c.src', ['ext.c.*'], { kind: 'grant' }));
    capability.sourceChanged('ext.c.src');
    await flush();

    expect(
      changes.map((change) => ({ owner: change.owner, revision: change.revision, reason: change.reason })),
    ).toEqual([
      // Revision 1 was already consumed by the hub's own core rights declaration at creation,
      // before this test's listener was even attached; the directory's one revision counter is
      // shared by every owner, never reset per owner.
      { owner: 'ext.c', revision: 2, reason: 'declared' },
      { owner: 'ext.c', revision: 3, reason: 'source-registered' },
      { owner: 'ext.c', revision: 4, reason: 'source-changed' },
    ]);
    expect(changes[0]?.rights).toEqual(['ext.c.r1']);
  });

  it('invalidates an existing cached right before the first announcement of a mutation that also restricts it', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const EXISTING_RIGHT: RightName = 'ext.h.existing';
    const grantingSource = createAnswerSource('ext.h.src', [EXISTING_RIGHT], { kind: 'grant' }, [EXISTING_RIGHT]);
    hub.activate(
      'ext.h',
      testExtensionPkg('ext.h', {
        rights: [{ right: EXISTING_RIGHT, description: 'd', context: {} }],
        rightsSources: [grantingSource],
      }),
    );
    const call = mintCallContext({ caller: CALLER, principal: CALLER });
    // Warm the cache: a payload-independent grant.
    await expect(hub.resolve({ call, right: EXISTING_RIGHT, context: {} })).resolves.toEqual({ granted: true });

    const seen: RightAnswer[] = [];
    bus.on(RightsSubjects.changed, (ctx) => {
      // A synchronous listener of the *first* announcement of the policy owner's activation.
      if (ctx.payload.owner !== 'ext.h.policy' || ctx.payload.reason !== 'declared') return;
      void hub.resolve({ call, right: EXISTING_RIGHT, context: {} }).then((answer) => seen.push(answer));
    });

    hub.activate(
      'ext.h.policy',
      testExtensionPkg('ext.h.policy', {
        rights: [{ right: 'ext.h.policy.new', description: 'd', context: {} }],
        rightsSources: [
          createAnswerSource('ext.h.policy.src', [EXISTING_RIGHT], { kind: 'deny', reason: 'restricted' }),
        ],
      }),
    );

    await flush();
    expect(seen).toEqual([{ granted: false, reason: 'restricted', by: 'ext.h.policy.src' }]);
  });

  it("a stop announcement listener using the stopped owner's capability throws, and nothing of the owner remains", async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const name = 'ext.i';
    hub.beginActivation(name);
    const capability = hub.capabilityFor(name, carrierFor(name));
    capability.declareRightsFromData([{ right: `${name}.r1`, description: 'd', context: {} }]);
    hub.activate(name, testExtensionPkg(name));

    let caught: unknown;
    bus.on(
      RightsSubjects.changed,
      () => {
        try {
          capability.declareRightsFromData([{ right: `${name}.r2`, description: 'd', context: {} }]);
        } catch (err) {
          caught = err;
        }
      },
      { filter: { owner: name } },
    );

    hub.deactivate(name);
    await flush();

    expect(caught).toBeInstanceOf(Error);
    expect(hub.list().some((entry) => entry.right === `${name}.r1`)).toBe(false);
    expect(hub.list().some((entry) => entry.right === `${name}.r2`)).toBe(false);
  });

  it("a synchronous declared listener registering another source through the now-active capability does not reorder revisions: the activation's own source-registered announcement precedes the listener's", async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const name = 'ext.n';
    const RIGHT: RightName = `${name}.thing`;
    hub.beginActivation(name);
    const capability = hub.capabilityFor(name, carrierFor(name));
    capability.declareRightsFromData([{ right: RIGHT, description: 'd', context: {} }]);
    capability.registerRightsSource(createAnswerSource(`${name}.src`, [RIGHT], { kind: 'grant' }));

    const changes: RightsChanged[] = [];
    bus.on(RightsSubjects.changed, (ctx) => {
      changes.push(ctx.payload);
      if (ctx.payload.owner !== name || ctx.payload.reason !== 'declared') return;
      // A synchronous listener of the activation's own `declared` announcement,
      // registering another source straight through the now-`active` owner's capability.
      capability.registerRightsSource(createAnswerSource(`${name}.src2`, [RIGHT], { kind: 'deny', reason: 'later' }));
    });

    hub.activate(name, testExtensionPkg(name));
    await flush();

    // Revisions strictly increasing, in the order the reasons below list them, is exactly
    // "the activation's own `source-registered` precedes the listener's reentrant one":
    // the listener's batch cannot have a lower revision than the batch whose announcement
    // triggered it.
    const revisions = changes.map((change) => change.revision);
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    expect(new Set(revisions).size).toBe(revisions.length);
    expect(changes.map((change) => change.reason)).toEqual(['declared', 'source-registered', 'source-registered']);
  });

  it("a context schema getter that calls the activating owner's declareRightsFromData throws, rolls activation back, and announces nothing", async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const name = 'ext.o';
    const RIGHT: RightName = `${name}.thing`;
    const OTHER: RightName = `${name}.other`;
    const changes: RightsChanged[] = [];
    bus.on(RightsSubjects.changed, collectInto(changes));

    hub.beginActivation(name);
    const capability = hub.capabilityFor(name, carrierFor(name));

    // Built with `Object.defineProperty` on a plain object so the schema's own type
    // (`JsonSchema`, a `Record<string, JsonValue>`) holds without a cast: parsing the right's
    // context against `RightDirectoryEntrySchema` reads `properties` while `activate` holds the
    // owner `activating`, so the reentrant call below — a mistake an extension could make by
    // calling back into its own still-activating capability — must throw.
    const context: JsonSchema = { type: 'object' };
    Object.defineProperty(context, 'properties', {
      enumerable: true,
      get(): JsonValue {
        capability.declareRightsFromData([{ right: OTHER, description: 'd', context: {} }]);
        return {};
      },
    });

    expect(() =>
      hub.activate(name, testExtensionPkg(name, { rights: [{ right: RIGHT, description: 'd', context }] })),
    ).toThrow();

    await flush();
    expect(changes).toEqual([]);
    expect(hub.list().some((entry) => entry.right === OTHER)).toBe(false);
    expect(hub.list().some((entry) => entry.right === RIGHT)).toBe(false);

    // The owner stays `pending`: a corrected activation still commits cleanly.
    expect(() =>
      hub.activate(
        name,
        testExtensionPkg(name, { rights: [{ right: RIGHT, description: 'd', context: { type: 'object' } }] }),
      ),
    ).not.toThrow();
    expect(hub.list().some((entry) => entry.right === RIGHT)).toBe(true);
    expect(hub.list().some((entry) => entry.right === OTHER)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Denial
// ---------------------------------------------------------------------------

describe('RightsHub: deny', () => {
  const PLACE = CoreDenialPlace.handler;
  const RIGHT: RightName = 'ext.d.thing';

  it('emits one makaio:access.denied and returns a matching AccessDeniedError', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const seen: AccessDenied[] = [];
    bus.on(AccessSubjects.denied, (ctx) => {
      seen.push(ctx.payload);
    });
    const call = mintCallContext({ caller: CALLER, principal: PRINCIPAL, attestedBy: ATTESTER });
    const question: RightQuestion = { call, right: RIGHT, context: {} };
    const answer: Extract<RightAnswer, { granted: false }> = { granted: false, reason: 'nope', by: 'ext.d.src' };

    const error = hub.deny(PLACE, {
      call: question.call,
      right: question.right,
      subject: 'acme.widget-created',
      reason: answer.reason,
      by: answer.by,
    });

    expect(error).toBeInstanceOf(AccessDeniedError);
    expect(error.code).toBe('forbidden');
    expect(error.data).toEqual({
      at: PLACE,
      right: RIGHT,
      subject: 'acme.widget-created',
      reason: 'nope',
      by: 'ext.d.src',
    });

    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      at: PLACE,
      ctx: { caller: CALLER, principal: PRINCIPAL, attestedBy: ATTESTER },
      right: RIGHT,
      subject: 'acme.widget-created',
      reason: 'nope',
      by: 'ext.d.src',
    });
  });

  it('a throwing access.denied listener does not change the returned error', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    bus.on(AccessSubjects.denied, () => {
      throw new Error('listener exploded');
    });
    const call = mintCallContext({ caller: CALLER, principal: CALLER });
    const question: RightQuestion = { call, right: RIGHT, context: {} };
    const answer: Extract<RightAnswer, { granted: false }> = { granted: false, reason: 'nope' };

    const error = hub.deny(PLACE, { call: question.call, right: question.right, reason: answer.reason });

    expect(error).toBeInstanceOf(AccessDeniedError);
    expect(error.data).toEqual({ at: PLACE, right: RIGHT, reason: 'nope' });
    await flush();
  });

  it('publishes both denials when the same call and right target different subjects', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const seen: AccessDenied[] = [];
    bus.on(AccessSubjects.denied, collectInto(seen));
    const call = mintCallContext({ caller: CALLER, principal: CALLER });

    hub.deny(PLACE, { call, right: RIGHT, subject: 'acme.first', reason: 'nope' });
    hub.deny(PLACE, { call, right: RIGHT, subject: 'acme.second', reason: 'nope' });

    await flush();
    expect(seen.map((denial) => denial.subject)).toEqual(['acme.first', 'acme.second']);
  });

  it('denies with neither a minted call nor a right, the one denial form a verifier chain at a boundary has to use', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const seen: AccessDenied[] = [];
    bus.on(AccessSubjects.denied, (ctx) => {
      seen.push(ctx.payload);
    });

    const error = hub.deny(CoreDenialPlace.boundary, { reason: 'chain-rejected' });

    expect(error).toBeInstanceOf(AccessDeniedError);
    expect(error.data).toEqual({ at: CoreDenialPlace.boundary, reason: 'chain-rejected' });

    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ at: CoreDenialPlace.boundary, reason: 'chain-rejected' });
  });

  it('a bus whose emit throws synchronously for access.denied still returns the matching AccessDeniedError', async () => {
    const realBus = createBusInstance();
    const throwingBus: IMakaioBus = {
      ...realBus,
      emit(call: CallContext, subject: unknown, payload: unknown) {
        if (subject === AccessSubjects.denied) throw new Error('synchronous denied-emit failure');
        return realBus.emit(call, subject as never, payload as never);
      },
    } as IMakaioBus;
    const hub = createRightsHub({ bus: throwingBus });
    const call = mintCallContext({ caller: CALLER, principal: CALLER });

    const error = hub.deny(PLACE, { call, right: RIGHT, reason: 'nope' });

    expect(error).toBeInstanceOf(AccessDeniedError);
    expect(error.data).toEqual({ at: PLACE, right: RIGHT, reason: 'nope' });
  });

  it('a bus whose own() throws synchronously still returns the matching AccessDeniedError', () => {
    const realBus = createBusInstance();
    const throwingBus: IMakaioBus = {
      ...realBus,
      own(): never {
        throw new Error('synchronous own() failure');
      },
    } as IMakaioBus;
    const hub = createRightsHub({ bus: throwingBus });

    const error = hub.deny(PLACE, { reason: 'nope' });

    expect(error).toBeInstanceOf(AccessDeniedError);
    expect(error.data).toEqual({ at: PLACE, reason: 'nope' });
  });

  it('a listener on access.denied that triggers the identical denied hasRight again does not loop', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const name = 'ext.loop';
    const loopRight: RightName = `${name}.thing`;
    hub.beginActivation(name);
    const capability = hub.capabilityFor(name, carrierFor(name));
    capability.registerRightsSource(createAnswerSource(`${name}.src`, [loopRight], { kind: 'deny', reason: 'nope' }));
    hub.activate(name, testExtensionPkg(name));

    const call = mintCallContext({ caller: CALLER, principal: CALLER });
    const seen: AccessDenied[] = [];
    let reentered = false;
    bus.on(AccessSubjects.denied, () => {
      seen.push({} as AccessDenied);
      if (!reentered) {
        // A listener reacting to this very denial asks the identical call/right again, the
        // exact reentrant case the guard in `emitDenial` exists for.
        reentered = true;
        void capability.handlerContext(call).hasRight(loopRight, {});
      }
    });

    await capability.handlerContext(call).hasRight(loopRight, {});
    await flush();
    await flush();

    // Exactly one denial was ever published for this call/right, even though the listener
    // triggered the identical denial again from inside itself: the guard, not stack
    // exhaustion or a timeout, is what stopped the second publication.
    expect(seen).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Processor
// ---------------------------------------------------------------------------

describe('RightsHub: processor', () => {
  it('processActivated registers rights and sources; processStopped removes them', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const changes: RightsChanged[] = [];
    bus.on(RightsSubjects.changed, (ctx) => {
      changes.push(ctx.payload);
    });
    const name = 'proc-ext';
    const pkg = testExtensionPkg(name, {
      rights: [{ right: 'proc-ext.r1', description: 'd', context: {} }],
      rightsSources: [createAnswerSource('proc-ext.src', ['proc-ext.*'], { kind: 'grant' })],
    });

    hub.activate(name, pkg);

    const call = mintCallContext({ caller: CALLER, principal: CALLER });
    await expect(hub.resolve({ call, right: 'proc-ext.r1', context: {} })).resolves.toEqual({ granted: true });
    expect(changes.map((change) => change.reason)).toEqual(['declared', 'source-registered']);

    hub.deactivate(name);

    await expect(hub.resolve({ call, right: 'proc-ext.r1', context: {} })).resolves.toEqual({
      granted: false,
      reason: RightDenialReason.rightUnknown,
    });
  });

  it('a failing activation throws, leaves the directory unchanged, and emits no rights.changed', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    // `a` and `a.b` both own `a.b.*` under the current ownership rule (see
    // rights-directory.ts planInsert/localContributionName): the directory
    // does not treat this as a conflict at declaration time, so this is how
    // two *different* extensions can collide on one answer-source name.
    const sharedSource = (): RightsSourceContribution => createAnswerSource('a.b.src', ['a.b.*'], { kind: 'grant' });

    hub.activate('a', testExtensionPkg('a', { rightsSources: [sharedSource()] }));

    const changes: RightsChanged[] = [];
    bus.on(RightsSubjects.changed, (ctx) => {
      changes.push(ctx.payload);
    });

    expect(() =>
      hub.activate(
        'a.b',
        testExtensionPkg('a.b', {
          rights: [{ right: 'a.b.r1', description: 'd', context: {} }],
          rightsSources: [sharedSource()],
        }),
      ),
    ).toThrow();

    expect(hub.list().some((entry) => entry.right === 'a.b.r1')).toBe(false);
    await flush();
    expect(changes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Staged activation lifecycle (beginActivation / pending / active / closed)
// ---------------------------------------------------------------------------

describe('RightsHub: staged activation lifecycle', () => {
  it('declareRightsFromData and registerRightsSource stage invisibly while pending; processActivated commits and announces', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const changes: RightsChanged[] = [];
    bus.on(RightsSubjects.changed, collectInto(changes));
    const name = 'ext.stage';
    hub.beginActivation(name);
    const capability = hub.capabilityFor(name, carrierFor(name));
    capability.declareRightsFromData([{ right: `${name}.r1`, description: 'd', context: {} }]);
    capability.registerRightsSource(createAnswerSource(`${name}.src`, [`${name}.*`], { kind: 'grant' }));
    const call = mintCallContext({ caller: CALLER, principal: CALLER });

    await expect(hub.resolve({ call, right: `${name}.r1`, context: {} })).resolves.toEqual({
      granted: false,
      reason: RightDenialReason.rightUnknown,
    });
    expect(hub.list().some((entry) => entry.right === `${name}.r1`)).toBe(false);
    await flush();
    expect(changes).toEqual([]);

    hub.activate(name, testExtensionPkg(name));

    await expect(hub.resolve({ call, right: `${name}.r1`, context: {} })).resolves.toEqual({ granted: true });
    await flush();
    expect(changes.map((change) => change.reason)).toEqual(['declared', 'source-registered']);
  });

  it('a second capabilityFor call for the same still-pending owner sees what the first staged (no discard)', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const name = 'ext.e1';
    hub.beginActivation(name);
    const first = hub.capabilityFor(name, carrierFor(name));
    first.declareRightsFromData([{ right: `${name}.r1`, description: 'd', context: {} }]);

    const second = hub.capabilityFor(name, carrierFor(name));
    second.registerRightsSource(createAnswerSource(`${name}.src`, [`${name}.*`], { kind: 'deny', reason: 'nope' }));

    hub.activate(name, testExtensionPkg(name));

    const call = mintCallContext({ caller: CALLER, principal: CALLER });
    // Denied, not merely granted-without-a-source: proves the activation committed both
    // the first capability's data right and the second capability's source from one record.
    await expect(hub.resolve({ call, right: `${name}.r1`, context: {} })).resolves.toEqual({
      granted: false,
      reason: 'nope',
      by: `${name}.src`,
    });
  });

  it('beginActivation discards everything staged before it and stales every capability bound earlier', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const name = 'ext.e2';
    hub.beginActivation(name);
    const stale = hub.capabilityFor(name, carrierFor(name));
    stale.declareRightsFromData([{ right: `${name}.r1`, description: 'd', context: {} }]);

    hub.beginActivation(name);

    expect(() => stale.declareRightsFromData([])).toThrow();
    const call = mintCallContext({ caller: CALLER, principal: CALLER });
    await expect(stale.resolve(call, { right: `${name}.r1`, context: {} })).rejects.toThrow();

    hub.activate(name, testExtensionPkg(name));
    expect(hub.list().some((entry) => entry.right === `${name}.r1`)).toBe(false);
  });

  it('beginActivation throws for an owner that is active', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const name = 'ext.e3';
    hub.beginActivation(name);
    hub.activate(name, testExtensionPkg(name));

    expect(() => hub.beginActivation(name)).toThrow(`Extension "${name}" is already active`);
  });

  it('beginActivation after processStopped starts a fresh pending lifecycle', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const name = 'ext.e4';
    hub.beginActivation(name);
    const first = hub.capabilityFor(name, carrierFor(name));
    first.declareRightsFromData([{ right: `${name}.r1`, description: 'd', context: {} }]);
    hub.activate(name, testExtensionPkg(name));
    hub.deactivate(name);

    expect(() => hub.beginActivation(name)).not.toThrow();
    const second = hub.capabilityFor(name, carrierFor(name));
    second.declareRightsFromData([{ right: `${name}.r2`, description: 'd', context: {} }]);
    hub.activate(name, testExtensionPkg(name));

    expect(hub.list().some((entry) => entry.right === `${name}.r1`)).toBe(false);
    expect(hub.list().some((entry) => entry.right === `${name}.r2`)).toBe(true);
  });

  it('after processStopped every capability method throws and nothing of the owner remains', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const name = 'ext.f';
    hub.beginActivation(name);
    const capability = hub.capabilityFor(name, carrierFor(name));
    capability.declareRightsFromData([{ right: `${name}.r1`, description: 'd', context: {} }]);
    capability.registerRightsSource(createAnswerSource(`${name}.src`, [`${name}.*`], { kind: 'grant' }));
    hub.activate(name, testExtensionPkg(name));

    hub.deactivate(name);

    const call = mintCallContext({ caller: CALLER, principal: CALLER });
    await expect(capability.resolve(call, { right: `${name}.r1`, context: {} })).rejects.toThrow();
    expect(() => capability.declareRightsFromData([])).toThrow();
    expect(() =>
      capability.registerRightsSource(createAnswerSource(`${name}.src2`, [`${name}.*`], { kind: 'grant' })),
    ).toThrow();
    expect(() => capability.sourceChanged(`${name}.src`)).toThrow();

    expect(hub.list().some((entry) => entry.right === `${name}.r1`)).toBe(false);
    await expect(hub.resolve({ call, right: `${name}.r1`, context: {} })).resolves.toEqual({
      granted: false,
      reason: RightDenialReason.rightUnknown,
    });
  });

  it('an invalid staged declaration throws at the call, not at activation', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const name = 'ext.g';
    hub.beginActivation(name);
    const capability = hub.capabilityFor(name, carrierFor(name));

    expect(() => capability.declareRightsFromData([{ right: 'other.thing', description: 'd', context: {} }])).toThrow();

    expect(() => hub.activate(name, testExtensionPkg(name))).not.toThrow();
    expect(hub.list().some((entry) => entry.right === 'other.thing')).toBe(false);
  });

  it('a synchronous declared listener registers a source through the now-active capability, applied directly to the directory (not silently dropped)', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const name = 'ext.k';
    const RIGHT: RightName = `${name}.thing`;
    hub.beginActivation(name);
    const capability = hub.capabilityFor(name, carrierFor(name));
    capability.declareRightsFromData([{ right: RIGHT, description: 'd', context: {} }]);

    bus.on(RightsSubjects.changed, (ctx) => {
      // The owner is already `active` by the time this (first) announcement of its own
      // activation fires: `registerRightsSource` must apply straight to the directory.
      if (ctx.payload.owner !== name || ctx.payload.reason !== 'declared') return;
      capability.registerRightsSource(createAnswerSource(`${name}.src`, [RIGHT], { kind: 'deny', reason: 'blocked' }));
    });

    hub.activate(name, testExtensionPkg(name));

    const call = mintCallContext({ caller: CALLER, principal: CALLER });
    await expect(hub.resolve({ call, right: RIGHT, context: {} })).resolves.toEqual({
      granted: false,
      reason: 'blocked',
      by: `${name}.src`,
    });
  });

  it('a failed activation leaves the owner pending with its staging intact, and announces nothing', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const name = 'ext.l';
    const RIGHT: RightName = `${name}.thing`;
    const changes: RightsChanged[] = [];
    bus.on(RightsSubjects.changed, collectInto(changes));

    hub.beginActivation(name);
    const capability = hub.capabilityFor(name, carrierFor(name));
    capability.declareRightsFromData([{ right: RIGHT, description: 'd', context: {} }]);
    // A source declared both statically and from data in the same activation is the
    // directory's own validation failure (see `rights-directory.ts` `activate`).
    expect(() =>
      hub.activate(name, testExtensionPkg(name, { rights: [{ right: RIGHT, description: 'd', context: {} }] })),
    ).toThrow();

    await flush();
    expect(changes).toEqual([]);
    expect(hub.list().some((entry) => entry.right === RIGHT)).toBe(false);

    // The attempt stays `pending`: a corrected, valid activation still commits what the
    // failed attempt staged.
    expect(() => hub.activate(name, testExtensionPkg(name))).not.toThrow();
    expect(hub.list().some((entry) => entry.right === RIGHT)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Bus handlers
// ---------------------------------------------------------------------------

describe('registerRightsHandlers', () => {
  const RIGHT: RightName = 'rh.secret';

  /** Denies the carrier `ext.b`, grants every other caller. */
  function denyExtBSource(): RightsSourceContribution {
    return createAnswerSource('rh.src', [RIGHT], {
      kind: 'fn',
      answer: (question) =>
        question.call.caller.id === 'ext.b' ? { granted: false, reason: 'ext.b-denied' } : { granted: true },
    });
  }

  async function setup(
    source: RightsSourceContribution = denyExtBSource(),
  ): Promise<{ bus: IMakaioBus; hub: RightsHub; cleanups: Array<() => void> }> {
    const bus = createBusInstance();
    leaseNamespace(bus, RightsNamespace, { kind: 'host' });
    const hub = createRightsHub({ bus });
    const name = 'rh';
    hub.beginActivation(name);
    const capability = hub.capabilityFor(name, carrierFor(name));
    capability.declareRightsFromData([{ right: RIGHT, description: 'd', context: {} }]);
    capability.registerRightsSource(source);
    hub.activate(name, testExtensionPkg(name));
    const cleanups = registerRightsHandlers(bus, hub);
    return { bus, hub, cleanups };
  }

  /**
   * Builds a minimal {@link BusTransport} whose only purpose is to inject a trusted
   * `TransportReceiveContext` into a `makaio:rights.resolve` request. `WithReceiveContext`
   * (`framework/core/bus-core/src/types/options.ts`) is `@internal` and never exposed on
   * `RequestOptions`, so there is no public `bus.request(..., { transport })`: a real
   * `BusTransport`, registered and driven through its own `onReceive`/`send`, is the
   * narrowest public path to a non-`undefined` `ctx.transport`.
   * @param name - Unique transport name, also used as `transportName` in the receive context.
   * @returns The transport (to register with `bus.registerTransport`) and a `request` helper
   * that delivers one `makaio:rights.resolve` request through it with the given connection id
   * (`undefined` when the transport supplies none).
   */
  function createReceiveContextTransport(name: string): {
    transport: BusTransport;
    request: (connectionId: string | undefined, caller: Party) => Promise<RightAnswer>;
  } {
    let handler: BusReceiveHandler | undefined;
    const pending = new Map<string, (response: BusResponseMessage) => void>();
    let counter = 0;
    const transport: BusTransport = {
      name,
      send: (async (message: BusMessage) => {
        if (message.type === 'response') {
          pending.get(message.correlationId)?.(message);
          pending.delete(message.correlationId);
        }
        return true;
      }) as BusTransport['send'],
      onReceive(h) {
        handler = h;
        return () => {
          handler = undefined;
        };
      },
      connect: async () => {},
      disconnect: async () => {},
      subscribe: async () => {},
      unsubscribe: async () => {},
    };
    return {
      transport,
      async request(connectionId, caller): Promise<RightAnswer> {
        if (!handler) throw new Error('transport not registered');
        counter += 1;
        const correlationId = `${name}-corr-${counter}`;
        const response = await new Promise<BusResponseMessage>((resolve) => {
          pending.set(correlationId, resolve);
          void handler?.(
            {
              type: 'request',
              namespace: RightsNamespace.name,
              subject: 'resolve',
              payload: { right: RIGHT, context: {} },
              correlationId,
              messageId: `${name}-msg-${counter}`,
            },
            { transportName: name, connectionId, caller },
          );
        });
        if (response.error) throw new Error(response.error.message);
        return response.result as RightAnswer;
      },
    };
  }

  it("answers makaio:rights.resolve for the sending extension's own received call", async () => {
    const { bus, cleanups } = await setup();
    const busB = createCarrierBus(bus, { kind: MAKAIO_EXTENSION_PARTY_KIND, id: 'ext.b' });
    const busC = createCarrierBus(bus, { kind: MAKAIO_EXTENSION_PARTY_KIND, id: 'ext.c' });

    const forB = await busB.request(busB.own('shared-work'), RightsSubjects.resolve, { right: RIGHT, context: {} });
    const forC = await busC.request(busC.own('shared-work'), RightsSubjects.resolve, { right: RIGHT, context: {} });

    expect(forB).toEqual({ granted: false, reason: 'ext.b-denied', by: 'rh.src' });
    expect(forC).toEqual({ granted: true });
    cleanups.forEach((cleanup) => cleanup());
  });

  it('rejects a payload carrying an extra key, such as a named call context', async () => {
    const { bus, cleanups } = await setup();
    const payloadWithForeignContext = {
      right: RIGHT,
      context: {},
      call: { caller: { kind: 'acme.other', id: 'o1' } },
    };

    await expect(
      bus.request(bus.own('shared-work'), RightsSubjects.resolve, payloadWithForeignContext),
    ).rejects.toBeInstanceOf(ValidationError);
    cleanups.forEach((cleanup) => cleanup());
  });

  it('makaio:rights.list returns the core rights plus declared ones, sorted, without functions', async () => {
    const { bus, cleanups } = await setup();

    const result = await bus.request(bus.own('shared-work'), RightsSubjects.list, {});

    const rightNames = result.rights.map((entry) => entry.right);
    expect(rightNames).toEqual([...rightNames].sort());
    expect(rightNames).toEqual(
      expect.arrayContaining([SUBJECT_HANDLE_RIGHT, SUBJECT_SEND_RIGHT, SUBJECT_SUBSCRIBE_RIGHT, RIGHT]),
    );
    for (const entry of result.rights) {
      expect(entry).not.toHaveProperty('answer');
    }
    cleanups.forEach((cleanup) => cleanup());
  });

  it('cleanups unregister the handlers', async () => {
    const { bus, cleanups } = await setup();

    cleanups.forEach((cleanup) => cleanup());

    await expect(bus.request(bus.own('shared-work'), RightsSubjects.list, {})).rejects.toBeInstanceOf(NoHandlerError);
  });

  describe('connection key (connectionOf)', () => {
    const CALLER_PARTY: PartyRef = { kind: 'acme.user', id: 'rh-conn-user' };

    /** A payload-independent granting source: cacheable, so the connection key alone governs re-asking. */
    function grantingSource(): RightsSourceContribution & { readonly calls: RightSourceQuestion[] } {
      return createAnswerSource('rh.granting', [RIGHT], { kind: 'grant' }, [RIGHT]);
    }

    it('asks the source twice for the same party over two different connections', async () => {
      const source = grantingSource();
      const { bus, cleanups } = await setup(source);
      const { transport, request } = createReceiveContextTransport('rh-conn-a');
      bus.registerTransport(transport);

      await request('conn-1', CALLER_PARTY);
      await request('conn-2', CALLER_PARTY);

      expect(source.calls).toHaveLength(2);
      cleanups.forEach((cleanup) => cleanup());
    });

    it('asks the source once for two requests on the same connection', async () => {
      const source = grantingSource();
      const { bus, cleanups } = await setup(source);
      const { transport, request } = createReceiveContextTransport('rh-conn-b');
      bus.registerTransport(transport);

      await request('conn-1', CALLER_PARTY);
      await request('conn-1', CALLER_PARTY);

      expect(source.calls).toHaveLength(1);
      cleanups.forEach((cleanup) => cleanup());
    });

    it('does not share a cache entry between an in-process request and one carrying a transport', async () => {
      const source = grantingSource();
      const { bus, cleanups } = await setup(source);
      const { transport, request } = createReceiveContextTransport('rh-conn-c');
      bus.registerTransport(transport);
      const busAsCaller = createCarrierBus(bus, CALLER_PARTY);

      await busAsCaller.request(busAsCaller.own('shared-work'), RightsSubjects.resolve, { right: RIGHT, context: {} });
      await request('conn-1', CALLER_PARTY);

      expect(source.calls).toHaveLength(2);
      cleanups.forEach((cleanup) => cleanup());
    });

    it('transport "a" with connection id "b" and transport "a:b" without a connection id do not share an entry', async () => {
      const source = grantingSource();
      const { bus, cleanups } = await setup(source);
      const transportA = createReceiveContextTransport('a');
      const transportAB = createReceiveContextTransport('a:b');
      bus.registerTransport(transportA.transport);
      bus.registerTransport(transportAB.transport);

      await transportA.request('b', CALLER_PARTY);
      await transportAB.request(undefined, CALLER_PARTY);

      // A string key built by concatenation (`${transportName}:${connectionId}`) would
      // collide both requests into `'a:b'`; the structured (transport, id) pair must not.
      expect(source.calls).toHaveLength(2);
      cleanups.forEach((cleanup) => cleanup());
    });

    it('never caches a question whose transport supplies no connection id: the source is asked every time', async () => {
      const source = grantingSource();
      const { bus, cleanups } = await setup(source);
      const { transport, request } = createReceiveContextTransport('rh-conn-d');
      bus.registerTransport(transport);

      await request(undefined, CALLER_PARTY);
      await request(undefined, CALLER_PARTY);

      expect(source.calls).toHaveLength(2);
      cleanups.forEach((cleanup) => cleanup());
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Round 5: the directory owns its data, drain depth, core declaration order,
//    and one failing emission never drops another
// ---------------------------------------------------------------------------

describe('RightsHub: the directory owns its data, drain depth, core declaration, emission errors', () => {
  it("mutating a source's `rights` array after registration does not change which rights it answers for", async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const name = 'ext.q';
    const RIGHT: RightName = `${name}.thing`;
    const OTHER: RightName = `${name}.other`;
    hub.activate(
      name,
      testExtensionPkg(name, {
        rights: [
          { right: RIGHT, description: 'd', context: {} },
          { right: OTHER, description: 'd', context: {} },
        ],
      }),
    );
    const capability = hub.capabilityFor(name, carrierFor(name));
    const mutableRights = [RIGHT];
    const source: RightsSourceContribution = {
      source: `${name}.src`,
      description: 'mutable rights array',
      rights: mutableRights,
      answer: async () => ({ granted: false, reason: 'blocked' }),
    };
    capability.registerRightsSource(source);

    // Mutating the extension's own array after registration must not retroactively widen
    // (or narrow) what the directory's copy covers.
    mutableRights.push(OTHER);

    const call = mintCallContext({ caller: CALLER, principal: CALLER });
    await expect(hub.resolve({ call, right: RIGHT, context: {} })).resolves.toEqual({
      granted: false,
      reason: 'blocked',
      by: `${name}.src`,
    });
    await expect(hub.resolve({ call, right: OTHER, context: {} })).resolves.toEqual({ granted: true });
  });

  it("a nested mutation through owner B's already-active capability, triggered from inside owner A's own activation, is published only after A's own batch, in commit order", async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const bName = 'ext.r.b';
    const nestedRight: RightName = `${bName}.extra`;
    hub.activate(bName, testExtensionPkg(bName));
    const bCapability = hub.capabilityFor(bName, carrierFor(bName));

    const aName = 'ext.r.a';
    const aRight: RightName = `${aName}.thing`;
    const changes: RightsChanged[] = [];
    bus.on(RightsSubjects.changed, collectInto(changes));

    // Built with `Object.defineProperty` so the schema parse's own read of `properties` while
    // the directory copies A's context is what triggers B's nested mutation — not a cast.
    const context: JsonSchema = { type: 'object' };
    Object.defineProperty(context, 'properties', {
      enumerable: true,
      get(): JsonValue {
        bCapability.declareRightsFromData([{ right: nestedRight, description: 'd', context: {} }]);
        return {};
      },
    });

    hub.activate(aName, testExtensionPkg(aName, { rights: [{ right: aRight, description: 'd', context }] }));
    await flush();

    // B's batch, committed from inside A's still-running activation, is published before A's
    // own batch — but only once A's own `withAnnouncements` call has returned (both are
    // already in `changes` by the time this assertion runs; the depth counter, not timing,
    // is what orders them).
    expect(changes.map((change) => ({ owner: change.owner, reason: change.reason }))).toEqual([
      { owner: bName, reason: 'declared' },
      { owner: aName, reason: 'declared' },
    ]);
    expect(hub.list().some((entry) => entry.right === nestedRight)).toBe(true);
    expect(hub.list().some((entry) => entry.right === aRight)).toBe(true);
  });

  it('a listener subscribed before hub creation is announced the core declaration exactly once; makaio:rights.list and the cache behave as for any other right', async () => {
    const bus = createBusInstance();
    leaseNamespace(bus, RightsNamespace, { kind: 'host' });
    const changes: RightsChanged[] = [];
    bus.on(RightsSubjects.changed, collectInto(changes));

    const hub = createRightsHub({ bus });
    const cleanups = registerRightsHandlers(bus, hub);
    await flush();

    const coreChanges = changes.filter((change) => change.owner === CORE_RIGHTS_OWNER);
    expect(coreChanges).toHaveLength(1);
    expect(coreChanges[0]?.reason).toBe('declared');
    expect([...(coreChanges[0]?.rights ?? [])].sort()).toEqual(
      [SUBJECT_HANDLE_RIGHT, SUBJECT_SEND_RIGHT, SUBJECT_SUBSCRIBE_RIGHT].sort(),
    );

    const listed = await bus.request(bus.own('shared-work'), RightsSubjects.list, {});
    expect(listed.rights.map((entry) => entry.right)).toEqual(
      expect.arrayContaining([SUBJECT_HANDLE_RIGHT, SUBJECT_SEND_RIGHT, SUBJECT_SUBSCRIBE_RIGHT]),
    );

    const call = mintCallContext({ caller: CALLER, principal: CALLER });
    await expect(
      hub.resolve({ call, right: SUBJECT_SEND_RIGHT, context: { subject: 'acme.widget-created' } }),
    ).resolves.toEqual({ granted: true });

    cleanups.forEach((cleanup) => cleanup());
  });

  it('a bus whose `emit` throws synchronously on the first change of a two-change batch still publishes the second', async () => {
    const realBus = createBusInstance();
    let emitCalls = 0;
    const throwingBus: IMakaioBus = {
      ...realBus,
      emit(call: CallContext, subject: typeof RightsSubjects.changed, payload: RightsChanged) {
        emitCalls += 1;
        // Call 1 is the hub's own core-rights declaration, emitted once at creation; let it
        // through, then fail synchronously on the first change of the next (two-change) batch.
        if (emitCalls === 2) throw new Error('synchronous emit failure');
        return realBus.emit(call, subject, payload);
      },
    } as IMakaioBus;
    const hub = createRightsHub({ bus: throwingBus });
    const changes: RightsChanged[] = [];
    realBus.on(RightsSubjects.changed, collectInto(changes));
    const name = 'ext.s';

    // One activation producing a two-change batch (`declared` then `source-registered`):
    // the first `bus.emit` call of the drain loop for this batch throws synchronously.
    hub.activate(
      name,
      testExtensionPkg(name, {
        rights: [{ right: `${name}.thing`, description: 'd', context: {} }],
        rightsSources: [createAnswerSource(`${name}.src`, [`${name}.*`], { kind: 'grant' })],
      }),
    );
    await flush();

    const ownChanges = changes.filter((change) => change.owner === name);
    expect(emitCalls).toBe(3);
    expect(ownChanges.map((change) => change.reason)).toEqual(['source-registered']);
  });
});

// ---------------------------------------------------------------------------
// 8. Round 6: frozen owned data, read-then-check-then-commit, single drainer
// ---------------------------------------------------------------------------

describe('RightsHub: frozen owned data, read-then-check-then-commit, single drainer', () => {
  it('mutating an object-valued enum inside a schema returned by list() throws, and resolution still treats an out-of-enum context as context-invalid', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const name = 'ext.t1';
    const RIGHT: RightName = `${name}.thing`;
    const context: JsonSchema = {
      type: 'object',
      properties: { tier: { enum: ['gold'] } },
      required: ['tier'],
      additionalProperties: false,
    };
    hub.activate(name, testExtensionPkg(name, { rights: [{ right: RIGHT, description: 'd', context }] }));

    const entry = hub.list().find((candidate) => candidate.right === RIGHT);
    if (entry === undefined) throw new Error(`right '${RIGHT}' not found in list()`);
    const properties = entry.context.properties as Record<string, JsonValue>;
    const tierSchema = properties.tier as Record<string, JsonValue>;
    const tierEnum = tierSchema.enum as JsonValue[];

    // The returned schema is frozen all the way down: pushing onto a nested enum array throws.
    expect(() => tierEnum.push('silver')).toThrow();

    const call = mintCallContext({ caller: CALLER, principal: CALLER });
    await expect(hub.resolve({ call, right: RIGHT, context: { tier: 'silver' } })).resolves.toEqual({
      granted: false,
      reason: RightDenialReason.contextInvalid,
    });
  });

  it('a listener of the first change in a two-change batch that registers a source itself publishes revisions strictly 2, 3, 4, never racing ahead of the batch it interrupted', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const name = 'ext.u';
    const RIGHT: RightName = `${name}.thing`;
    hub.beginActivation(name);
    const capability = hub.capabilityFor(name, carrierFor(name));
    capability.declareRightsFromData([{ right: RIGHT, description: 'd', context: {} }]);
    capability.registerRightsSource(createAnswerSource(`${name}.src1`, [RIGHT], { kind: 'grant' }));

    const changes: RightsChanged[] = [];
    bus.on(RightsSubjects.changed, (ctx) => {
      changes.push(ctx.payload);
      // Fires on the *first* change of the activation's own two-change batch (`declared`,
      // revision 2 — revision 1 was already consumed by the hub's own core rights declaration at
      // creation): the same batch's own `source-registered` (revision 3) is still waiting,
      // mid-iteration, when this reentrant mutation (revision 4) commits and queues.
      if (ctx.payload.owner !== name || ctx.payload.reason !== 'declared') return;
      capability.registerRightsSource(createAnswerSource(`${name}.src2`, [RIGHT], { kind: 'grant' }));
    });

    hub.activate(name, testExtensionPkg(name));
    await flush();

    expect(
      changes.map((change) => ({ owner: change.owner, revision: change.revision, reason: change.reason })),
    ).toEqual([
      { owner: name, revision: 2, reason: 'declared' },
      { owner: name, revision: 3, reason: 'source-registered' },
      { owner: name, revision: 4, reason: 'source-registered' },
    ]);
  });

  it('clearing the caller-owned array passed to declareRightsFromData while pending does not remove the right from the next activation', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const name = 'ext.v';
    const RIGHT: RightName = `${name}.thing`;
    hub.beginActivation(name);
    const capability = hub.capabilityFor(name, carrierFor(name));

    const mutableDataRights: RightFromData[] = [{ right: RIGHT, description: 'd', context: {} }];
    capability.declareRightsFromData(mutableDataRights);
    // The caller clears its own array after staging: the directory's own copy, taken while
    // staging, is what the next activation commits — not this (now emptied) reference.
    mutableDataRights.length = 0;

    hub.activate(name, testExtensionPkg(name));

    expect(hub.list().some((entry) => entry.right === RIGHT)).toBe(true);
  });

  it("a pending owner's schema getter that mutates another, already-active owner: that owner's announcement is published only once the pending owner's staging call has returned, never from inside it", async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const activeName = 'ext.y.active';
    const pendingName = 'ext.y.pending';
    const RIGHT: RightName = `${activeName}.thing`;
    hub.activate(
      activeName,
      testExtensionPkg(activeName, { rights: [{ right: RIGHT, description: 'd', context: {} }] }),
    );
    const activeCapability = hub.capabilityFor(activeName, carrierFor(activeName));

    const changes: RightsChanged[] = [];
    bus.on(RightsSubjects.changed, collectInto(changes));

    hub.beginActivation(pendingName);
    const pendingCapability = hub.capabilityFor(pendingName, carrierFor(pendingName));

    let changesDuringGetter: number | undefined;
    // Built with `Object.defineProperty` so the directory's own copy (parsed against
    // `RightDirectoryEntrySchema` during planning) is what triggers the nested mutation, not a cast.
    const context: JsonSchema = { type: 'object' };
    Object.defineProperty(context, 'properties', {
      enumerable: true,
      get(): JsonValue {
        activeCapability.registerRightsSource(createAnswerSource(`${activeName}.src`, [RIGHT], { kind: 'grant' }));
        changesDuringGetter = changes.length;
        return {};
      },
    });

    pendingCapability.declareRightsFromData([{ right: `${pendingName}.thing`, description: 'd', context }]);

    // The reentrant mutation committed (and is queued), but its announcement had not been
    // published yet while the getter itself was still running: the pending owner's own
    // staging call was still mid-copy, not yet returned.
    expect(changesDuringGetter).toBe(0);
    await flush();
    expect(changes.map((change) => ({ owner: change.owner, reason: change.reason }))).toEqual([
      { owner: activeName, reason: 'source-registered' },
    ]);
  });

  it('a source with a sparse `rights` array throws before any write; nothing visible or announced, the owner stays pending', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const name = 'ext.bb';
    const changes: RightsChanged[] = [];
    bus.on(RightsSubjects.changed, collectInto(changes));
    hub.beginActivation(name);
    const capability = hub.capabilityFor(name, carrierFor(name));

    // A genuine sparse array, built without a cast: `new Array(2)` leaves index 0 an
    // unassigned hole, which the schema's array parse reads as `undefined` — `z.string()`
    // rejects that, the same way it would reject a `[, 'x.y']` literal.
    const sparseMutable = new Array<string>(2);
    sparseMutable[1] = 'x.y';
    const sparseRights: readonly string[] = sparseMutable;
    const source: RightsSourceContribution = {
      source: `${name}.src`,
      description: 'sparse',
      rights: sparseRights,
      answer: async () => ({ granted: true }),
    };

    expect(() => capability.registerRightsSource(source)).toThrow();
    await flush();
    expect(changes).toEqual([]);

    // The owner stayed `pending` with nothing staged: a clean activation still commits fine.
    expect(() => hub.activate(name, testExtensionPkg(name))).not.toThrow();
    expect(hub.list().some((entry) => entry.right.startsWith(name))).toBe(false);
  });

  it('a manifest getter that calls deactivate for the activating owner: that call throws, and the activation itself still commits cleanly, never closed then revived', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const name = 'ext.cc';
    const RIGHT: RightName = `${name}.thing`;
    hub.beginActivation(name);

    let caught: unknown;
    // Built with `Object.defineProperty` so the schema parse's own read of `properties` while
    // the directory copies this right's context — which runs while `activate` holds the owner
    // `activating` — is what triggers the reentrant `deactivate` call, not a cast.
    const context: JsonSchema = { type: 'object' };
    Object.defineProperty(context, 'properties', {
      enumerable: true,
      get(): JsonValue {
        try {
          hub.deactivate(name);
        } catch (err) {
          caught = err;
        }
        return {};
      },
    });

    expect(() =>
      hub.activate(name, testExtensionPkg(name, { rights: [{ right: RIGHT, description: 'd', context }] })),
    ).not.toThrow();

    expect(caught).toBeInstanceOf(Error);
    // Active with its rights — never `closed` by the reentrant call and then silently revived.
    expect(hub.list().some((entry) => entry.right === RIGHT)).toBe(true);
  });

  it('a context schema with a `Date` default throws on declaration: non-JSON values never reach the directory', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const name = 'ext.dd';
    const RIGHT: RightName = `${name}.thing`;
    const context: JsonSchema = { type: 'object', properties: { when: { default: new Date() } } };

    expect(() =>
      hub.activate(name, testExtensionPkg(name, { rights: [{ right: RIGHT, description: 'd', context }] })),
    ).toThrow();

    expect(hub.list().some((entry) => entry.right === RIGHT)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. Silent "no source → grant" default made visible
// ---------------------------------------------------------------------------

describe('RightsHub: logs the "no source → grant" default once per right', () => {
  it('logs once for a right with no source, however many times it is asked', async () => {
    const bus = createBusInstance();
    const hub = createRightsHub({ bus });
    const name = 'ext.nosource';
    const RIGHT: RightName = `${name}.thing`;
    hub.activate(name, testExtensionPkg(name, { rights: [{ right: RIGHT, description: 'd', context: {} }] }));
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    try {
      const call = mintCallContext({ caller: CALLER, principal: CALLER });
      await hub.resolve({ call, right: RIGHT, context: {} });
      await hub.resolve({ call, right: RIGHT, context: {} });
      await hub.resolve({ call, right: RIGHT, context: {} });

      const logged = info.mock.calls.filter((args) => String(args[0]).includes(RIGHT));
      expect(logged).toHaveLength(1);
    } finally {
      info.mockRestore();
    }
  });
});
