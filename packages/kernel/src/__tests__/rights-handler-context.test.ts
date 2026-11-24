import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBusInstance } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import type { CallContext } from '@makaio/core';
import { AccessSubjects, CoreDenialPlace } from '@makaio/contracts/access';
import type { AccessDenied } from '@makaio/contracts/access';
import { RightAnswerSchema, RightDenialReason } from '@makaio/contracts/rights';
import type {
  HandlerContext,
  RightAnswer,
  RightContribution,
  RightSourceQuestion,
  RightsSourceContribution,
} from '@makaio/contracts/rights';
import type { JsonSchema } from '@makaio/contracts/shared';
import { ExtensionCoordinator } from '../extension/extension-coordinator.js';
import type { KernelExtensionContext, KernelMakaioExtension } from '../extension/types.js';
import { TEST_EXTENSION_CONTEXT_BASE as TEST_PKG_CTX_BASE } from './extension-context-base-fixture.js';

/** Waits one macrotask turn, long enough for a fire-and-forget `bus.emit` to settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// Fixtures: a right one object's owner holds, and an answer source that
// grants only the owning caller. Styled after `rights-coordinator.test.ts`.
// ---------------------------------------------------------------------------

/** Contexts the coordinator hands to `create`, captured by extension name. */
type ContextRegistry = Map<string, KernelExtensionContext>;

/**
 * Looks up a captured context.
 * @param contexts - Registry filled by the test extensions.
 * @param name - Extension name.
 * @returns The context of that extension.
 */
function contextOf(contexts: ContextRegistry, name: string): KernelExtensionContext {
  const ctx = contexts.get(name);
  if (ctx === undefined) throw new Error(`no context captured for '${name}'`);
  return ctx;
}

/** JSON schema of the question context `ext.b.ownedRead` declares: the owning party's id. */
const OWNED_CONTEXT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: { owner: { type: 'string' } },
  required: ['owner'],
  additionalProperties: false,
};

const OWNED_READ_RIGHT = 'ext.b.ownedRead';

/** The right `ext.b` declares in its manifest: read of one object owned by one party. */
const OWNED_READ_CONTRIBUTION: RightContribution = {
  right: OWNED_READ_RIGHT,
  description: 'Read one object owned by one party.',
  context: OWNED_CONTEXT_SCHEMA,
};

/**
 * Answer source `ext.b` registers: grants a question only when the object's
 * `owner` is the asking call's own caller.
 */
const OWNER_ONLY_SOURCE: RightsSourceContribution = {
  source: 'ext.b.ownerOnly',
  description: "Grants only when the object's owner is the asking caller.",
  rights: [OWNED_READ_RIGHT],
  async answer(question: RightSourceQuestion): Promise<RightAnswer> {
    const context = question.context as { owner?: unknown };
    const owner = typeof context.owner === 'string' ? context.owner : undefined;
    if (owner !== undefined && owner === question.call.caller.id) return { granted: true };
    return { granted: false, reason: 'not-owner' };
  },
};

/** Ad-hoc request namespace B serves: asks `ctx.rights.handlerContext(call).hasRight(...)` and returns the answer. */
const testNamespace = createBusNamespace('test:handler-context', {
  ask: {
    request: z.object({ right: z.string(), context: z.record(z.string(), z.unknown()) }),
    response: RightAnswerSchema,
  },
});

/**
 * Builds and starts a coordinator with `ext.b` (declaring `ext.b.ownedRead`, registering
 * `ext.b.ownerOnly`, and serving `ask` through `ctx.rights.handlerContext`) and `ext.a` (a bare
 * caller). Every handler context B's `ask` handler builds, and the `call` it received, is
 * recorded in request order.
 * @returns The coordinator, the captured contexts, the `ask` subject, the handler contexts B
 * built and the calls its handler received, both in the order its handler ran.
 */
async function startAskerAndAnswerer(): Promise<{
  coordinator: ExtensionCoordinator;
  contexts: ContextRegistry;
  ask: (typeof testNamespace)['subjects']['ask'];
  handlerContexts: HandlerContext[];
  receivedCalls: CallContext[];
}> {
  const bus = createBusInstance();
  const { subjects } = bus.registerNamespace(testNamespace);
  const coordinator = new ExtensionCoordinator(bus, { extensionContextBase: TEST_PKG_CTX_BASE });
  const contexts: ContextRegistry = new Map();
  const handlerContexts: HandlerContext[] = [];
  const receivedCalls: CallContext[] = [];

  const extB: KernelMakaioExtension = {
    name: 'ext.b',
    displayName: 'ext.b',
    version: '0.1.0',
    rights: [OWNED_READ_CONTRIBUTION],
    create: (ctx) => {
      contexts.set('ext.b', ctx);
      ctx.rights.registerRightsSource(OWNER_ONLY_SOURCE);
      ctx.bus.on(subjects.ask, async (reqCtx) => {
        const handlerContext = ctx.rights.handlerContext(reqCtx.call);
        handlerContexts.push(handlerContext);
        receivedCalls.push(reqCtx.call);
        reqCtx.setResult(await handlerContext.hasRight(reqCtx.payload.right, reqCtx.payload.context));
      });
      return { init: () => Promise.resolve(), destroy: () => undefined };
    },
  };
  const extA: KernelMakaioExtension = {
    name: 'ext.a',
    displayName: 'ext.a',
    version: '0.1.0',
    create: (ctx) => {
      contexts.set('ext.a', ctx);
      return { init: () => Promise.resolve(), destroy: () => undefined };
    },
  };

  coordinator.load([extB, extA]);
  await coordinator.startAll();
  return { coordinator, contexts, ask: subjects.ask, handlerContexts, receivedCalls };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HandlerContext.hasRight over the real bus handler path', () => {
  it("grants its own object, denies another party's, binds the received call, and denies an undeclared right", async () => {
    const { coordinator, contexts, ask, handlerContexts, receivedCalls } = await startAskerAndAnswerer();
    const a = contextOf(contexts, 'ext.a');

    // (a) A asks about its own object: granted.
    const granted = await a.bus.request(a.bus.own('start'), ask, {
      right: OWNED_READ_RIGHT,
      context: { owner: 'ext.a' },
    });
    expect(granted).toEqual({ granted: true });

    // (b) A asks about another party's object: denied, carrying what `resolve` answers today.
    const denied = await a.bus.request(a.bus.own('start'), ask, {
      right: OWNED_READ_RIGHT,
      context: { owner: 'ext.somebody-else' },
    });
    expect(denied).toEqual({ granted: false, reason: 'not-owner', by: 'ext.b.ownerOnly' });

    // (c) The handler context's `call` is exactly the `context.call` the handler received, whose
    // caller is the requesting extension (the send derives it; it is not the sender's own context).
    expect(handlerContexts).toHaveLength(2);
    expect(handlerContexts[0]?.call).toBe(receivedCalls[0]);
    expect(handlerContexts[1]?.call).toBe(receivedCalls[1]);
    expect(receivedCalls[0]?.caller.id).toBe('ext.a');

    // (e) A right no active extension declares: denied exactly as `resolve` denies it today.
    const undeclared = await a.bus.request(a.bus.own('start'), ask, {
      right: 'ext.nobody.declares',
      context: {},
    });
    expect(undeclared).toEqual({ granted: false, reason: RightDenialReason.rightUnknown });

    await coordinator.shutdown();
  });

  it('rejects, like `resolve`, when `hasRight` is called on a handler context built before the owner stopped', async () => {
    const { coordinator, contexts, ask, handlerContexts } = await startAskerAndAnswerer();
    const a = contextOf(contexts, 'ext.a');

    const granted = await a.bus.request(a.bus.own('start'), ask, {
      right: OWNED_READ_RIGHT,
      context: { owner: 'ext.a' },
    });
    expect(granted).toEqual({ granted: true });

    const handlerContextBeforeStop = handlerContexts[0];
    if (handlerContextBeforeStop === undefined) throw new Error('no handler context captured');

    await coordinator.applyExtensionTransition('ext.b', false);

    await expect(handlerContextBeforeStop.hasRight(OWNED_READ_RIGHT, { owner: 'ext.a' })).rejects.toThrow(
      /ext\.b.*has stopped/,
    );

    await coordinator.shutdown();
  });

  it('a denied `hasRight` is announced as one `makaio:access.denied` at `makaio.handler`; a granted one announces none', async () => {
    const { coordinator, contexts, ask } = await startAskerAndAnswerer();
    const a = contextOf(contexts, 'ext.a');
    const denials: AccessDenied[] = [];
    a.bus.on(AccessSubjects.denied, (ctx) => {
      denials.push(ctx.payload);
    });

    const granted = await a.bus.request(a.bus.own('start'), ask, {
      right: OWNED_READ_RIGHT,
      context: { owner: 'ext.a' },
    });
    expect(granted).toEqual({ granted: true });
    await flush();
    expect(denials).toHaveLength(0);

    const denied = await a.bus.request(a.bus.own('start'), ask, {
      right: OWNED_READ_RIGHT,
      context: { owner: 'ext.somebody-else' },
    });
    expect(denied.granted).toBe(false);

    await flush();
    expect(denials).toHaveLength(1);
    expect(denials[0]).toMatchObject({
      at: CoreDenialPlace.handler,
      right: OWNED_READ_RIGHT,
      reason: 'not-owner',
    });

    await coordinator.shutdown();
  });
});
