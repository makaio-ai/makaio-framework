import { isMintedCallContext } from '@makaio/bus-core';
import type { Party } from '@makaio/contracts';
import { createBusNamespace } from '@makaio/core';
import type { CallContext } from '@makaio/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createTestBusInstance } from '../bus-test-harness.js';
import { createTestCall } from '../call-context.js';
import { createTestHandlerContext } from '../handler-context.js';

const CALLER: Party = { kind: 'acme.service', id: 'svc-1' };
const PRINCIPAL: Party = { kind: 'acme.person', id: 'person-1' };
const ATTESTER: Party = { kind: 'acme.gateway', id: 'gateway-1' };

describe('createTestCall', () => {
  it('mints a context with the host party "test" as caller and principal by default', () => {
    const call = createTestCall();

    expect(isMintedCallContext(call)).toBe(true);
    expect(call.caller).toEqual({ kind: 'makaio.host', id: 'test' });
    expect(call.principal).toEqual(call.caller);
    expect(call.attestedBy).toBeUndefined();
  });

  it('sets the three parties and freezes the context deeply', () => {
    const call = createTestCall({ caller: CALLER, principal: PRINCIPAL, attestedBy: ATTESTER });

    expect(isMintedCallContext(call)).toBe(true);
    expect(call.caller).toEqual(CALLER);
    expect(call.principal).toEqual(PRINCIPAL);
    expect(call.attestedBy).toEqual(ATTESTER);
    expect(Object.isFrozen(call)).toBe(true);
    expect(Object.isFrozen(call.caller)).toBe(true);
    expect(Object.isFrozen(call.principal)).toBe(true);
    expect(Object.isFrozen(call.attestedBy)).toBe(true);
  });

  it('omits attestedBy when it is not given', () => {
    const call = createTestCall({ caller: CALLER });

    expect(call.principal).toEqual(CALLER);
    expect('attestedBy' in call).toBe(false);
  });

  it('is accepted by a real bus: the handler sees the passed principal and the instance carrier as caller', async () => {
    const bus = createTestBusInstance();
    const namespace = bus.registerNamespace(
      createBusNamespace('testCallContextSend', {
        load: { request: z.object({ id: z.string() }), response: z.object({ ok: z.boolean() }) },
      }),
    );
    const seen: CallContext[] = [];
    bus.on(namespace.subjects.load, (ctx) => {
      seen.push(ctx.call);
      ctx.setResult({ ok: true });
    });

    const result = await bus.request(
      createTestCall({ caller: CALLER, principal: PRINCIPAL, attestedBy: ATTESTER }),
      namespace.subjects.load,
      { id: '1' },
    );

    expect(result).toEqual({ ok: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].principal).toEqual(PRINCIPAL);
    expect(seen[0].attestedBy).toEqual(ATTESTER);
    expect(seen[0].caller).toEqual(bus.own('root').caller);
    expect(seen[0].caller).not.toEqual(CALLER);
  });
});

describe('createTestHandlerContext', () => {
  it('exposes the payload', () => {
    const ctx = createTestHandlerContext({ id: 'a' });

    expect(ctx.payload).toEqual({ id: 'a' });
  });

  it('setResult sets the result', () => {
    const ctx = createTestHandlerContext<{ id: string }, { ok: boolean }>({ id: 'a' });
    expect(ctx.result).toBeUndefined();

    ctx.setResult({ ok: true });

    expect(ctx.result).toEqual({ ok: true });
  });

  it('extendResult merges fields into the result', () => {
    const ctx = createTestHandlerContext<{ id: string }, { a?: number; b?: number }>({ id: 'a' });

    ctx.extendResult({ a: 1 });
    ctx.extendResult({ b: 2 });

    expect(ctx.result).toEqual({ a: 1, b: 2 });
  });

  it('replacePayload replaces the payload', () => {
    const ctx = createTestHandlerContext({ id: 'a' });

    ctx.replacePayload({ id: 'b' });

    expect(ctx.payload).toEqual({ id: 'b' });
  });

  it('defaults call to a minted context', () => {
    const ctx = createTestHandlerContext({ id: 'a' });

    expect(isMintedCallContext(ctx.call)).toBe(true);
  });

  it('gives each context its own string messageId', () => {
    const first = createTestHandlerContext({ id: 'a' });
    const second = createTestHandlerContext({ id: 'a' });

    expect(typeof first.messageId).toBe('string');
    expect(typeof second.messageId).toBe('string');
    expect(first.messageId).not.toBe(second.messageId);
  });

  it('passes a given call and messageId through', () => {
    const call = createTestCall({ caller: CALLER });

    const ctx = createTestHandlerContext({ id: 'a' }, { call, messageId: 'm-1' });

    expect(ctx.call).toBe(call);
    expect(ctx.messageId).toBe('m-1');
  });
});
