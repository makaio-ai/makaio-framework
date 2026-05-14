import { describe, it, expect, beforeEach } from 'vitest';
import { MakaioBus } from '../bus.js';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';

// Register namespace for testing replacePayload in request middleware
const { subjects: RequestSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('replacePayloadTest', {
    process: {
      request: z.object({ input: z.string() }),
      response: z.object({ output: z.string() }),
    },
  }),
);

describe('Request middleware replacePayload', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('should allow middleware to replace payload for subsequent handlers', async () => {
    // High priority handler that modifies the payload
    MakaioBus.on(
      RequestSubjects.process,
      async (ctx) => {
        // Modify the input before passing to next handler
        ctx.replacePayload({ input: `[modified] ${ctx.payload.input}` });
        await ctx.next();
      },
      { priority: 100 },
    );

    // Lower priority handler that processes the modified payload
    MakaioBus.on(
      RequestSubjects.process,
      (ctx) => {
        ctx.setResult({ output: ctx.payload.input.toUpperCase() });
      },
      { priority: 50 },
    );

    const result = await MakaioBus.request(RequestSubjects.process, {
      input: 'test',
    });

    // The result should reflect the modified payload
    expect(result.output).toBe('[MODIFIED] TEST');
  });

  it('should preserve payload changes through the middleware chain', async () => {
    const payloadSnapshots: string[] = [];

    // First modifier
    MakaioBus.on(
      RequestSubjects.process,
      async (ctx) => {
        payloadSnapshots.push(`before-1: ${ctx.payload.input}`);
        ctx.replacePayload({ input: `[1] ${ctx.payload.input}` });
        payloadSnapshots.push(`after-1: ${ctx.payload.input}`);
        await ctx.next();
      },
      { priority: 100 },
    );

    // Second modifier
    MakaioBus.on(
      RequestSubjects.process,
      async (ctx) => {
        payloadSnapshots.push(`before-2: ${ctx.payload.input}`);
        ctx.replacePayload({ input: `[2] ${ctx.payload.input}` });
        payloadSnapshots.push(`after-2: ${ctx.payload.input}`);
        await ctx.next();
      },
      { priority: 50 },
    );

    // Final handler
    MakaioBus.on(
      RequestSubjects.process,
      (ctx) => {
        payloadSnapshots.push(`final: ${ctx.payload.input}`);
        ctx.setResult({ output: ctx.payload.input });
      },
      { priority: 0 },
    );

    const result = await MakaioBus.request(RequestSubjects.process, {
      input: 'original',
    });

    expect(payloadSnapshots).toEqual([
      'before-1: original',
      'after-1: [1] original',
      'before-2: [1] original',
      'after-2: [2] [1] original',
      'final: [2] [1] original',
    ]);
    expect(result.output).toBe('[2] [1] original');
  });

  it('should allow replacePayload with merged objects', async () => {
    // Handler that merges additional fields into the payload
    MakaioBus.on(
      RequestSubjects.process,
      async (ctx) => {
        ctx.replacePayload({
          ...ctx.payload,
          input: `${ctx.payload.input} + enriched`,
        });
        await ctx.next();
      },
      { priority: 100 },
    );

    // Handler that processes the enriched payload
    MakaioBus.on(
      RequestSubjects.process,
      (ctx) => {
        ctx.setResult({ output: ctx.payload.input });
      },
      { priority: 50 },
    );

    const result = await MakaioBus.request(RequestSubjects.process, {
      input: 'base',
    });

    expect(result.output).toBe('base + enriched');
  });
});
