import { describe, it, expect, beforeEach } from 'vitest';
import { MakaioBus } from '../bus.js';
import { z } from 'zod';

const { subjects: TestSubjects } = MakaioBus.registerNamespace('extendResultTest', {
  query: {
    request: z.object({ id: z.string() }),
    response: z.object({
      name: z.string(),
      score: z.number(),
      tags: z.array(z.string()).optional(),
    }),
  },
});

describe('RequestContext.extendResult()', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('starts from empty object when no result was set', async () => {
    MakaioBus.on(
      TestSubjects.query,
      (ctx) => {
        ctx.extendResult({ name: 'alice' });
        ctx.extendResult({ score: 42 });
      },
      { priority: 0 },
    );

    const result = await MakaioBus.request(TestSubjects.query, { id: '1' });
    expect(result).toEqual({ name: 'alice', score: 42 });
  });

  it('merges into an existing result from setResult', async () => {
    MakaioBus.on(
      TestSubjects.query,
      (ctx) => {
        ctx.setResult({ name: 'alice', score: 10 });
        ctx.extendResult({ score: 99 });
      },
      { priority: 0 },
    );

    const result = await MakaioBus.request(TestSubjects.query, { id: '1' });
    expect(result).toEqual({ name: 'alice', score: 99 });
  });

  it('merges into downstream result after next()', async () => {
    MakaioBus.on(
      TestSubjects.query,
      async (ctx) => {
        await ctx.next();
        ctx.extendResult({ tags: ['enriched'] });
      },
      { priority: 100 },
    );

    MakaioBus.on(
      TestSubjects.query,
      (ctx) => {
        ctx.setResult({ name: 'bob', score: 7 });
      },
      { priority: 0 },
    );

    const result = await MakaioBus.request(TestSubjects.query, { id: '1' });
    expect(result).toEqual({ name: 'bob', score: 7, tags: ['enriched'] });
  });

  it('accumulates across multiple extendResult calls', async () => {
    MakaioBus.on(
      TestSubjects.query,
      (ctx) => {
        ctx.extendResult({ name: 'start' });
        ctx.extendResult({ score: 1 });
        ctx.extendResult({ tags: ['a', 'b'] });
      },
      { priority: 0 },
    );

    const result = await MakaioBus.request(TestSubjects.query, { id: '1' });
    expect(result).toEqual({ name: 'start', score: 1, tags: ['a', 'b'] });
  });

  it('makes result readable via ctx.result after extend', async () => {
    let observed: unknown;

    MakaioBus.on(
      TestSubjects.query,
      (ctx) => {
        ctx.extendResult({ name: 'check' });
        ctx.extendResult({ score: 5 });
        observed = ctx.result;
      },
      { priority: 0 },
    );

    await MakaioBus.request(TestSubjects.query, { id: '1' });
    expect(observed).toEqual({ name: 'check', score: 5 });
  });

  it('works in a two-interceptor chain enriching downstream', async () => {
    MakaioBus.on(
      TestSubjects.query,
      async (ctx) => {
        await ctx.next();
        ctx.extendResult({ tags: ['outer'] });
      },
      { priority: 200 },
    );

    MakaioBus.on(
      TestSubjects.query,
      async (ctx) => {
        await ctx.next();
        ctx.extendResult({ score: 99 });
      },
      { priority: 100 },
    );

    MakaioBus.on(
      TestSubjects.query,
      (ctx) => {
        ctx.setResult({ name: 'base', score: 0 });
      },
      { priority: 0 },
    );

    const result = await MakaioBus.request(TestSubjects.query, { id: '1' });
    expect(result).toEqual({ name: 'base', score: 99, tags: ['outer'] });
  });
});

describe('broadcast extendResult()', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('accumulates multiple extendResult calls in broadcast results', async () => {
    MakaioBus.on(TestSubjects.query, (ctx) => {
      ctx.identify?.('node-a');
      ctx.extendResult({ name: 'alice' });
      ctx.extendResult({ score: 42 });
      ctx.extendResult({ tags: ['a'] });
    });

    const results = await MakaioBus.broadcast(TestSubjects.query, { id: '1' });
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ nodeId: 'node-a', payload: { name: 'alice', score: 42, tags: ['a'] } });
  });

  it('reflects extendResult calls after setResult in broadcast results', async () => {
    MakaioBus.on(TestSubjects.query, (ctx) => {
      ctx.identify?.('node-b');
      ctx.setResult({ name: 'bob', score: 0 });
      ctx.extendResult({ score: 77 });
      ctx.extendResult({ tags: ['enriched'] });
    });

    const results = await MakaioBus.broadcast(TestSubjects.query, { id: '1' });
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({ nodeId: 'node-b', payload: { name: 'bob', score: 77, tags: ['enriched'] } });
  });

  it('each broadcast handler accumulates independently', async () => {
    MakaioBus.on(TestSubjects.query, (ctx) => {
      ctx.identify?.('handler-1');
      ctx.extendResult({ name: 'first' });
      ctx.extendResult({ score: 1 });
    });

    MakaioBus.on(TestSubjects.query, (ctx) => {
      ctx.identify?.('handler-2');
      ctx.extendResult({ name: 'second' });
      ctx.extendResult({ score: 2 });
    });

    const results = await MakaioBus.broadcast(TestSubjects.query, { id: '1' });
    expect(results).toHaveLength(2);

    const byNode = Object.fromEntries(results.map((r) => [r.nodeId, r.payload]));
    expect(byNode['handler-1']).toEqual({ name: 'first', score: 1 });
    expect(byNode['handler-2']).toEqual({ name: 'second', score: 2 });
  });
});
