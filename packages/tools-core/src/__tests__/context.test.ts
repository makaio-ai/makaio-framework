import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import type { MakaioContext } from '@makaio/core';
import { createBusNamespace } from '@makaio/core';
import { createBusInstance, MakaioBus } from '@makaio/bus-core';
import type { BusLike, ToolExecutionContext } from '../types.js';

// Create test subjects for BusLike tests
const { subjects: TestSubjects } = MakaioBus.registerNamespace(
  createBusNamespace('toolsCoreTest', {
    testEvent: z.object({ data: z.string() }),
    testRequest: {
      request: z.object({ input: z.string() }),
      response: z.object({ echoed: z.object({ input: z.string() }) }),
    },
  }),
);

describe('BusLike', () => {
  it('should be IMakaioBus with emit, request, and on methods', () => {
    // Type-level test: verify BusLike is IMakaioBus
    const bus = createBusInstance();

    // Verify the bus has the expected methods
    expect(typeof bus.emit).toBe('function');
    expect(typeof bus.request).toBe('function');
    expect(typeof bus.on).toBe('function');
  });

  it('should support emitting events', async () => {
    const bus = createBusInstance();
    const emitCalls: Array<unknown> = [];

    bus.on(TestSubjects.testEvent, (ctx) => {
      emitCalls.push(ctx.payload);
    });

    await bus.emit(TestSubjects.testEvent, { data: 'value' });

    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0]).toEqual({ data: 'value' });
  });

  it('should support request-response pattern', async () => {
    const bus = createBusInstance();

    bus.on(TestSubjects.testRequest, (ctx) => {
      ctx.setResult({ echoed: ctx.payload });
    });

    const result = await bus.request(TestSubjects.testRequest, { input: 'hello' });

    expect(result).toEqual({ echoed: { input: 'hello' } });
  });

  it('should return unsubscribe function from on()', () => {
    const bus = createBusInstance();
    const calls: Array<unknown> = [];

    const unsubscribe = bus.on(TestSubjects.testEvent, (ctx) => {
      calls.push(ctx.payload);
    });

    expect(typeof unsubscribe).toBe('function');

    // Should receive events before unsubscribe
    bus.emit(TestSubjects.testEvent, { data: 'first' });

    unsubscribe();

    // Should not receive events after unsubscribe
    bus.emit(TestSubjects.testEvent, { data: 'second' });

    // Note: emit is async, so we can't immediately check the calls length
    // This test verifies that unsubscribe is a function; actual behavior is tested in bus-core
  });
});

describe('ToolExecutionContext', () => {
  it('should extend MakaioContext', () => {
    // Type-level test: ToolExecutionContext should be assignable to MakaioContext
    const ctx: ToolExecutionContext = {
      cwd: '/test',
      env: { NODE_ENV: 'test' },
      platform: 'posix',
    };

    // Should be assignable to MakaioContext
    const makaioCtx: MakaioContext = ctx;
    expect(makaioCtx.cwd).toBe('/test');
  });

  it('should have optional sessionId property', () => {
    const ctxWithSession: ToolExecutionContext = {
      cwd: '/test',
      env: {},
      platform: 'posix',
      sessionId: 'session-123',
    };

    const ctxWithoutSession: ToolExecutionContext = {
      cwd: '/test',
      env: {},
      platform: 'posix',
    };

    expect(ctxWithSession.sessionId).toBe('session-123');
    expect(ctxWithoutSession.sessionId).toBeUndefined();
  });

  it('should have optional bus property', () => {
    const bus = createBusInstance();

    const ctxWithBus: ToolExecutionContext = {
      cwd: '/test',
      env: {},
      platform: 'posix',
      bus,
    };

    const ctxWithoutBus: ToolExecutionContext = {
      cwd: '/test',
      env: {},
      platform: 'posix',
    };

    expect(ctxWithBus.bus).toBe(bus);
    expect(ctxWithoutBus.bus).toBeUndefined();
  });

  it('should allow both sessionId and bus together', () => {
    const bus = createBusInstance();

    const ctx: ToolExecutionContext = {
      cwd: '/test',
      env: {},
      platform: 'posix',
      sessionId: 'session-456',
      bus,
    };

    expect(ctx.sessionId).toBe('session-456');
    expect(ctx.bus).toBe(bus);
  });

  it('should preserve all MakaioContext properties', () => {
    const signal = new AbortController().signal;

    const ctx: ToolExecutionContext = {
      cwd: '/workspace',
      env: { PATH: '/usr/bin', HOME: '/home/user' },
      platform: 'windows',
      signal,
      constraints: { maxFileSize: 1024 },
      sessionId: 'session-789',
    };

    // All MakaioContext properties should be accessible
    expect(ctx.cwd).toBe('/workspace');
    expect(ctx.env.PATH).toBe('/usr/bin');
    expect(ctx.platform).toBe('windows');
    expect(ctx.signal).toBe(signal);
    expect(ctx.constraints?.maxFileSize).toBe(1024);

    // Extended properties
    expect(ctx.sessionId).toBe('session-789');
  });
});

describe('Type compatibility', () => {
  it('ToolExecutionContext should be usable where MakaioContext is expected', () => {
    // This is a compile-time check - if this file compiles, the test passes
    function acceptsMakaioContext(ctx: MakaioContext): string {
      return ctx.cwd;
    }

    const toolCtx: ToolExecutionContext = {
      cwd: '/test',
      env: {},
      platform: 'posix',
      sessionId: 'sess-1',
    };

    // Should compile without errors
    const result = acceptsMakaioContext(toolCtx);
    expect(result).toBe('/test');
  });

  it('should verify BusLike type constraints', () => {
    // Type-level assertions using expectTypeOf
    expectTypeOf<BusLike>().toHaveProperty('emit');
    expectTypeOf<BusLike>().toHaveProperty('request');
    expectTypeOf<BusLike>().toHaveProperty('on');
  });

  it('should verify ToolExecutionContext type constraints', () => {
    // Type-level assertions
    expectTypeOf<ToolExecutionContext>().toMatchTypeOf<MakaioContext>();
    expectTypeOf<ToolExecutionContext>().toHaveProperty('sessionId');
    expectTypeOf<ToolExecutionContext>().toHaveProperty('bus');
  });
});
