import { describe, it, expect, beforeEach } from 'bun:test';
import { MakaioBus } from '../bus.js';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';

const { subjects: TestSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('resultGetterTest', {
    compute: {
      request: z.object({ input: z.number() }),
      response: z.object({ output: z.number() }),
    },
  }),
);

describe('RequestContext.result getter', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('is undefined before any handler sets a result', async () => {
    let observedResult: unknown = 'sentinel';

    MakaioBus.on(
      TestSubjects.compute,
      (ctx) => {
        observedResult = ctx.result;
        ctx.setResult({ output: 42 });
      },
      { priority: 0 },
    );

    await MakaioBus.request(TestSubjects.compute, { input: 1 });
    expect(observedResult).toBeUndefined();
  });

  it('reflects the value after setResult()', async () => {
    let observedResult: unknown;

    MakaioBus.on(
      TestSubjects.compute,
      (ctx) => {
        ctx.setResult({ output: 42 });
        observedResult = ctx.result;
      },
      { priority: 0 },
    );

    await MakaioBus.request(TestSubjects.compute, { input: 1 });
    expect(observedResult).toEqual({ output: 42 });
  });

  it('reflects the downstream result after await next()', async () => {
    let interceptorResult: unknown;

    MakaioBus.on(
      TestSubjects.compute,
      async (ctx) => {
        expect(ctx.result).toBeUndefined();
        await ctx.next();
        interceptorResult = ctx.result;
      },
      { priority: 100 },
    );

    MakaioBus.on(
      TestSubjects.compute,
      (ctx) => {
        ctx.setResult({ output: ctx.payload.input * 10 });
      },
      { priority: 0 },
    );

    const response = await MakaioBus.request(TestSubjects.compute, { input: 7 });
    expect(response).toEqual({ output: 70 });
    expect(interceptorResult).toEqual({ output: 70 });
  });

  it('allows interceptor to enrich the downstream result', async () => {
    MakaioBus.on(
      TestSubjects.compute,
      async (ctx) => {
        await ctx.next();
        const downstream = ctx.result as { output: number };
        ctx.setResult({ output: downstream.output + 1 });
      },
      { priority: 100 },
    );

    MakaioBus.on(
      TestSubjects.compute,
      (ctx) => {
        ctx.setResult({ output: ctx.payload.input * 10 });
      },
      { priority: 0 },
    );

    const response = await MakaioBus.request(TestSubjects.compute, { input: 5 });
    expect(response).toEqual({ output: 51 });
  });

  it('prefers local setResult over downstream when set before next()', async () => {
    let interceptorResult: unknown;

    MakaioBus.on(
      TestSubjects.compute,
      async (ctx) => {
        ctx.setResult({ output: 999 });
        await ctx.next();
        interceptorResult = ctx.result;
      },
      { priority: 100 },
    );

    MakaioBus.on(
      TestSubjects.compute,
      (ctx) => {
        ctx.setResult({ output: 1 });
      },
      { priority: 0 },
    );

    const response = await MakaioBus.request(TestSubjects.compute, { input: 0 });
    // setResult before next() means the interceptor's value wins
    expect(response).toEqual({ output: 999 });
    // result getter reflects the interceptor's own value (downstream was discarded)
    expect(interceptorResult).toEqual({ output: 999 });
  });

  it('works across a three-handler chain', async () => {
    const observations: Array<{ handler: string; result: unknown }> = [];

    MakaioBus.on(
      TestSubjects.compute,
      async (ctx) => {
        observations.push({ handler: 'outer', result: ctx.result });
        await ctx.next();
        observations.push({ handler: 'outer-after', result: ctx.result });
      },
      { priority: 200 },
    );

    MakaioBus.on(
      TestSubjects.compute,
      async (ctx) => {
        observations.push({ handler: 'middle', result: ctx.result });
        await ctx.next();
        observations.push({ handler: 'middle-after', result: ctx.result });
      },
      { priority: 100 },
    );

    MakaioBus.on(
      TestSubjects.compute,
      (ctx) => {
        ctx.setResult({ output: 42 });
        observations.push({ handler: 'inner', result: ctx.result });
      },
      { priority: 0 },
    );

    await MakaioBus.request(TestSubjects.compute, { input: 1 });

    expect(observations).toEqual([
      { handler: 'outer', result: undefined },
      { handler: 'middle', result: undefined },
      { handler: 'inner', result: { output: 42 } },
      { handler: 'middle-after', result: { output: 42 } },
      { handler: 'outer-after', result: { output: 42 } },
    ]);
  });
});
