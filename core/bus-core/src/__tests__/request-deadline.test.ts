/**
 * Tests for RequestContext.deadline — the absolute Unix timestamp (ms) computed
 * once at the request entry point and propagated to every handler in the chain.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import { createBusContext, createBusInstance, MakaioBus } from '../index.js';
import { createBidirectionalTransportPair } from './helpers/transport-fixtures.js';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '../types/options.js';

const DeadlineNamespaceDefinition = createBusNamespace('deadlineTest', {
  echo: {
    request: z.object({ value: z.string() }),
    response: z.object({ echo: z.string() }),
  },
});
const { subjects: DeadlineSubjects } = MakaioBus.registerNamespace(DeadlineNamespaceDefinition);

describe('RequestContext.deadline', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  it('exposes an absolute timestamp close to Date.now() + timeout', async () => {
    let observedDeadline: number | undefined;

    MakaioBus.on(DeadlineSubjects.echo, (ctx) => {
      observedDeadline = ctx.deadline;
      ctx.setResult({ echo: ctx.payload.value });
    });

    const timeout = 5000;
    const before = Date.now();
    await MakaioBus.request(DeadlineSubjects.echo, { value: 'a' }, { timeout });
    const after = Date.now();

    expect(observedDeadline).toBeDefined();
    // deadline should be approximately before + timeout, within a few ms of test execution
    expect(observedDeadline).toBeGreaterThanOrEqual(before + timeout);
    expect(observedDeadline).toBeLessThanOrEqual(after + timeout);
  });

  it('is undefined when timeout is 0 (no-timeout semantics)', async () => {
    let observedDeadline: number | undefined = -1;

    MakaioBus.on(DeadlineSubjects.echo, (ctx) => {
      observedDeadline = ctx.deadline;
      ctx.setResult({ echo: ctx.payload.value });
    });

    await MakaioBus.request(DeadlineSubjects.echo, { value: 'b' }, { timeout: 0 });

    expect(observedDeadline).toBeUndefined();
  });

  it('produces a deadline from the default timeout when no explicit timeout is given', async () => {
    let observedDeadline: number | undefined;

    MakaioBus.on(DeadlineSubjects.echo, (ctx) => {
      observedDeadline = ctx.deadline;
      ctx.setResult({ echo: ctx.payload.value });
    });

    const before = Date.now();
    await MakaioBus.request(DeadlineSubjects.echo, { value: 'c' });
    const after = Date.now();

    expect(observedDeadline).toBeDefined();
    // Default timeout is 60_000 ms
    expect(observedDeadline).toBeGreaterThanOrEqual(before + DEFAULT_REQUEST_TIMEOUT_MS);
    expect(observedDeadline).toBeLessThanOrEqual(after + DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it('propagates the same deadline to every handler in a middleware chain', async () => {
    const deadlines: Array<{ handler: string; deadline: number | undefined }> = [];

    MakaioBus.on(
      DeadlineSubjects.echo,
      async (ctx) => {
        deadlines.push({ handler: 'outer', deadline: ctx.deadline });
        await ctx.next();
      },
      { priority: 200 },
    );

    MakaioBus.on(
      DeadlineSubjects.echo,
      async (ctx) => {
        deadlines.push({ handler: 'middle', deadline: ctx.deadline });
        await ctx.next();
      },
      { priority: 100 },
    );

    MakaioBus.on(
      DeadlineSubjects.echo,
      (ctx) => {
        deadlines.push({ handler: 'inner', deadline: ctx.deadline });
        ctx.setResult({ echo: ctx.payload.value });
      },
      { priority: 0 },
    );

    await MakaioBus.request(DeadlineSubjects.echo, { value: 'd' }, { timeout: 3000 });

    expect(deadlines).toHaveLength(3);
    // All three handlers must observe the exact same deadline value (same reference timestamp)
    const allDeadlines = deadlines.map((d) => d.deadline);
    expect(allDeadlines[0]).toBeDefined();
    expect(allDeadlines[0]).toBe(allDeadlines[1]);
    expect(allDeadlines[1]).toBe(allDeadlines[2]);
  });

  it('is absent from broadcast contexts (broadcast has no deadline)', async () => {
    let observedDeadline: number | undefined = -1;

    MakaioBus.on(DeadlineSubjects.echo, (ctx) => {
      observedDeadline = ctx.deadline;
      ctx.setResult({ echo: ctx.payload.value });
    });

    await MakaioBus.broadcast(DeadlineSubjects.echo, { value: 'e' });

    expect(observedDeadline).toBeUndefined();
  });

  it('auto-advances through handlers that call neither setResult nor next, preserving deadline', async () => {
    const deadlines: Array<number | undefined> = [];

    // First handler does nothing — auto-advance kicks in
    MakaioBus.on(
      DeadlineSubjects.echo,
      (ctx) => {
        deadlines.push(ctx.deadline);
        // Intentionally no setResult or next() — auto-advance
      },
      { priority: 100 },
    );

    // Second handler produces the result
    MakaioBus.on(
      DeadlineSubjects.echo,
      (ctx) => {
        deadlines.push(ctx.deadline);
        ctx.setResult({ echo: ctx.payload.value });
      },
      { priority: 0 },
    );

    await MakaioBus.request(DeadlineSubjects.echo, { value: 'auto-advance' }, { timeout: 2000 });

    expect(deadlines).toHaveLength(2);
    expect(deadlines[0]).toBeDefined();
    expect(deadlines[0]).toBe(deadlines[1]);
  });

  it('preserves one absolute deadline through local middleware and a remote terminal handler', async () => {
    let wireDeadline: number | undefined;
    const pair = createBidirectionalTransportPair({
      label: 'deadline-remote-terminal',
      spy: (message, direction) => {
        if (direction === 'a-to-b' && message.type === 'request') wireDeadline = message.deadline;
      },
    });
    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });
    busA.registerNamespace(DeadlineNamespaceDefinition);
    busB.registerNamespace(DeadlineNamespaceDefinition);

    let localDeadline: number | undefined;
    let remoteDeadline: number | undefined;
    const localCleanup = busA.on(
      DeadlineSubjects.echo,
      async (ctx) => {
        localDeadline = ctx.deadline;
        await ctx.next();
      },
      { priority: 100 },
    );
    const remoteCleanup = busB.on(DeadlineSubjects.echo, (ctx) => {
      remoteDeadline = ctx.deadline;
      ctx.setResult({ echo: ctx.payload.value });
    });

    busA.registerTransport(pair.sideA);
    busB.registerTransport(pair.sideB);
    busA.getContext().remoteRequestHandlers.set('deadlineTest.echo', [{ transport: pair.sideA.name, priority: 0 }]);

    try {
      await busA.request(DeadlineSubjects.echo, { value: 'remote' }, { timeout: 5000 });

      expect(localDeadline).toBeDefined();
      expect(wireDeadline).toBe(localDeadline);
      expect(remoteDeadline).toBe(localDeadline);
    } finally {
      localCleanup();
      remoteCleanup();
      busA.disconnect();
      busB.disconnect();
    }
  });

  it('keeps the deadline undefined at a remote terminal handler when timeout is zero', async () => {
    const pair = createBidirectionalTransportPair({ label: 'deadline-no-timeout-remote' });
    const busA = createBusInstance({ context: createBusContext() });
    const busB = createBusInstance({ context: createBusContext() });
    busA.registerNamespace(DeadlineNamespaceDefinition);
    busB.registerNamespace(DeadlineNamespaceDefinition);

    let remoteDeadline: number | undefined = -1;
    const remoteCleanup = busB.on(DeadlineSubjects.echo, (ctx) => {
      remoteDeadline = ctx.deadline;
      ctx.setResult({ echo: ctx.payload.value });
    });
    busA.registerTransport(pair.sideA);
    busB.registerTransport(pair.sideB);
    busA.getContext().remoteRequestHandlers.set('deadlineTest.echo', [{ transport: pair.sideA.name, priority: 0 }]);

    try {
      await busA.request(DeadlineSubjects.echo, { value: 'no-timeout' }, { timeout: 0 });
      expect(remoteDeadline).toBeUndefined();
    } finally {
      remoteCleanup();
      busA.disconnect();
      busB.disconnect();
    }
  });
});
