import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { SessionSubjects } from '@makaio/contracts';

const connectionMock = vi.hoisted(() => ({
  ensureConnection: vi.fn(() => Promise.resolve(MakaioBus)),
  closeConnection: vi.fn(() => undefined),
}));

const runtimeMock = vi.hoisted(() => ({
  ensureRuntime: vi.fn(() => Promise.resolve(MakaioBus)),
  shutdownRuntime: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/core/connection.js', () => connectionMock);
vi.mock('../../src/runtime/boot.js', () => runtimeMock);

const core = await import('../../src/core/index.js');
const runtime = await import('../../src/runtime/index.js');

const SESSION_ID = 'entrypoint-contract-session';

const asQueryShape = (
  value: unknown,
): {
  next?: unknown;
  return?: unknown;
  throw?: unknown;
  close?: unknown;
  [Symbol.asyncIterator]?: unknown;
} =>
  value as {
    next?: unknown;
    return?: unknown;
    throw?: unknown;
    close?: unknown;
    [Symbol.asyncIterator]?: unknown;
  };

const closeIfPresent = (value: unknown): void => {
  const query = asQueryShape(value);
  if (typeof query.close === 'function') query.close();
};

const silenceAsyncCleanup = (value: unknown): void => {
  if (value instanceof Promise) {
    void value.then(closeIfPresent).catch(() => undefined);
  }
};

const expectSynchronousQueryShape = (value: unknown): void => {
  silenceAsyncCleanup(value);
  const query = asQueryShape(value);

  expect(value).not.toBeInstanceOf(Promise);
  expect(typeof query.next).toBe('function');
  expect(typeof query.return).toBe('function');
  expect(typeof query.throw).toBe('function');
  expect(typeof query[Symbol.asyncIterator]).toBe('function');
  expect(typeof query.close).toBe('function');
  closeIfPresent(value);
};

describe('agent-sdk public entrypoint contract', () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    connectionMock.ensureConnection.mockClear();
    runtimeMock.ensureRuntime.mockClear();

    const unsub = MakaioBus.on(SessionSubjects.sendMessage, (ctx) => {
      ctx.setResult({
        messageId: 'entrypoint-message',
        turnId: 'entrypoint-turn',
        sessionId: SESSION_ID,
      });
    });
    cleanups.push(unsub);
  });

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
    MakaioBus.__resetHandlers?.();
  });

  it('/core query() returns a MakaioQuery synchronously', () => {
    const query = core.query({ prompt: 'hello', options: { model: 'sonnet', sessionId: SESSION_ID } });

    expectSynchronousQueryShape(query);
  });

  it('/runtime query() returns a MakaioQuery synchronously', () => {
    const query = runtime.query({ prompt: 'hello', options: { model: 'sonnet', sessionId: SESSION_ID } });

    expectSynchronousQueryShape(query);
  });

  it('/core exports createSdkMcpServer', () => {
    expect(core).toHaveProperty('createSdkMcpServer');
    expect(typeof (core as unknown as Record<string, unknown>)['createSdkMcpServer']).toBe('function');
  });

  it('/runtime exports createSdkMcpServer', () => {
    expect(runtime).toHaveProperty('createSdkMcpServer');
    expect(typeof (runtime as unknown as Record<string, unknown>)['createSdkMcpServer']).toBe('function');
  });
});
