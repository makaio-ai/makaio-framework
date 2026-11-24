import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import { createBusInstance } from '@makaio/bus-core';
import { createBusNamespace } from '@makaio/core';
import { ExtensionCoordinator } from '@makaio/kernel';
import { ReactionRegistry } from '../../../reaction/reaction-registry.js';
import { makeTestInvocationInput } from '../../../reaction/__tests__/reaction-test-fixtures.js';
import { SEND_BUS_REQUEST_REACTION_KIND, createSendBusRequestReaction } from '../send-bus-request-reaction.js';

/** Test namespace with one request subject, `echo.say`. */
const echoNamespace = createBusNamespace('echo', {
  say: { request: z.object({ value: z.string() }), response: z.object({ value: z.string() }) },
});

describe('createSendBusRequestReaction (makaio.send-bus-request)', () => {
  it('carries its canonical kind', () => {
    const bus = createBusInstance();
    const reaction = createSendBusRequestReaction(bus, new ExtensionCoordinator(bus).ruleRights.resolveRuleSendRight);
    expect(reaction.kind).toBe(SEND_BUS_REQUEST_REACTION_KIND);
    expect(reaction.kind).toBe('makaio.send-bus-request');
  });

  it('sends exactly one request with the given call and returns the response as result', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(echoNamespace);
    const correlationId = 'rule-occasion-1';
    const receivedCorrelationIds: Array<string | undefined> = [];
    bus.on(echoNamespace.subjects.say, (ctx) => {
      receivedCorrelationIds.push(ctx.correlationId);
      ctx.setResult({ value: `echo:${ctx.payload.value}` });
    });

    const registry = new ReactionRegistry(bus);
    await registry.init();
    registry.register('makaio', [
      createSendBusRequestReaction(bus, new ExtensionCoordinator(bus).ruleRights.resolveRuleSendRight),
    ]);

    const outcome = await registry.invoke(
      SEND_BUS_REQUEST_REACTION_KIND,
      { subject: 'echo.say', payload: { value: 'hi' } },
      makeTestInvocationInput(bus, { correlationId }),
    );

    expect(outcome).toEqual({ state: 'accepted', result: { value: 'echo:hi' } });
    expect(receivedCorrelationIds).toEqual([correlationId]);

    await registry.destroy();
  });

  it.each([
    ['fails the bus response schema', z.string().min(3), 'no'],
    ['fails the JSON result schema', z.bigint(), 1n],
  ] as const)('reports an unknown outcome when the response %s', async (_failure, valueSchema, value) => {
    const bus = createBusInstance();
    const namespace = createBusNamespace('echo', {
      say: { request: z.object({}), response: z.object({ value: valueSchema }) },
    });
    bus.registerNamespace(namespace);
    let handled = false;
    bus.on(namespace.subjects.say, (ctx) => {
      handled = true;
      ctx.setResult({ value });
    });

    const registry = new ReactionRegistry(bus);
    onTestFinished(() => registry.destroy());
    await registry.init();
    registry.register('makaio', [
      createSendBusRequestReaction(bus, new ExtensionCoordinator(bus).ruleRights.resolveRuleSendRight),
    ]);

    const outcome = await registry.invoke(
      SEND_BUS_REQUEST_REACTION_KIND,
      { subject: 'echo.say', payload: {} },
      makeTestInvocationInput(bus),
    );

    expect(handled).toBe(true);
    expect(outcome).toMatchObject({ state: 'failed', code: 'outcome-unknown' });
  });

  it('retries when no handler is registered for the subject', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(echoNamespace);

    const registry = new ReactionRegistry(bus);
    await registry.init();
    registry.register('makaio', [
      createSendBusRequestReaction(bus, new ExtensionCoordinator(bus).ruleRights.resolveRuleSendRight),
    ]);

    const outcome = await registry.invoke(
      SEND_BUS_REQUEST_REACTION_KIND,
      { subject: 'echo.say', payload: { value: 'hi' } },
      makeTestInvocationInput(bus),
    );

    expect(outcome.state).toBe('retry');

    await registry.destroy();
  });

  it('fails with code outcome-unknown when the request times out', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(echoNamespace);
    bus.on(echoNamespace.subjects.say, () => new Promise(() => {}));

    const registry = new ReactionRegistry(bus);
    await registry.init();
    registry.register('makaio', [
      createSendBusRequestReaction(bus, new ExtensionCoordinator(bus).ruleRights.resolveRuleSendRight),
    ]);

    const outcome = await registry.invoke(
      SEND_BUS_REQUEST_REACTION_KIND,
      { subject: 'echo.say', payload: { value: 'hi' }, timeoutMs: 10 },
      makeTestInvocationInput(bus),
    );

    expect(outcome).toMatchObject({ state: 'failed', code: 'outcome-unknown' });

    await registry.destroy();
  });

  it('reports an unknown outcome when a dispatched request is aborted', async () => {
    const bus = createBusInstance();
    const host = new AbortController();
    bus.registerNamespace(echoNamespace);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    bus.on(echoNamespace.subjects.say, async (ctx) => {
      entered.resolve();
      await release.promise;
      ctx.setResult({ value: 'sent' });
    });
    const registry = new ReactionRegistry(bus);
    await registry.init();
    registry.register('makaio', [
      createSendBusRequestReaction(bus, new ExtensionCoordinator(bus).ruleRights.resolveRuleSendRight),
    ]);

    const invocation = registry.invoke(
      SEND_BUS_REQUEST_REACTION_KIND,
      { subject: 'echo.say', payload: { value: 'hi' } },
      makeTestInvocationInput(bus, { hostSignal: host.signal }),
    );
    await entered.promise;
    host.abort();
    release.resolve();
    await expect(invocation).resolves.toMatchObject({ state: 'failed', code: 'outcome-unknown' });
    await registry.destroy();
  });

  it('fails with code invalid-payload when the payload violates the subject schema', async () => {
    const bus = createBusInstance();
    bus.registerNamespace(echoNamespace);
    bus.on(echoNamespace.subjects.say, (ctx) => ctx.setResult({ value: 'unused' }));

    const registry = new ReactionRegistry(bus);
    await registry.init();
    registry.register('makaio', [
      createSendBusRequestReaction(bus, new ExtensionCoordinator(bus).ruleRights.resolveRuleSendRight),
    ]);

    const outcome = await registry.invoke(
      SEND_BUS_REQUEST_REACTION_KIND,
      { subject: 'echo.say', payload: { value: 42 } },
      makeTestInvocationInput(bus),
    );

    expect(outcome).toMatchObject({ state: 'failed', code: 'invalid-payload' });

    await registry.destroy();
  });

  it('fails with code invalid-subject for a subject with no addressable namespace', async () => {
    const bus = createBusInstance();
    const registry = new ReactionRegistry(bus);
    await registry.init();
    registry.register('makaio', [
      createSendBusRequestReaction(bus, new ExtensionCoordinator(bus).ruleRights.resolveRuleSendRight),
    ]);

    const outcome = await registry.invoke(
      SEND_BUS_REQUEST_REACTION_KIND,
      { subject: 'nodot', payload: {} },
      makeTestInvocationInput(bus),
    );

    expect(outcome).toMatchObject({ state: 'failed', code: 'invalid-subject' });

    await registry.destroy();
  });
});
