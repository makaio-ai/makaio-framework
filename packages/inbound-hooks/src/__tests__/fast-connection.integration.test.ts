/**
 * Integration tests for the fast hook connection against a real WebSocket bus.
 *
 * The server side is a real `createBusInstance()` with a `ServerTransport` on a real
 * `ws` server (port 0, HMAC auth). Nothing in bus-core or the transport is mocked.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { createBusInstance } from '@makaio/bus-core';
import { HmacAuth, ServerTransport } from '@makaio/bus-transport-websocket';
import {
  connectFastHookBus,
  createInboundHookNamespace,
  emitInboundHookReceived,
  emitInboundHookReceivedFast,
} from '../index.js';
import type { RawInboundHookPayload } from '../index.js';

const SECRET = 'fast-hook-integration-secret';
const CONNECT_TIMEOUT_MS = 1_000;

describe('fast hook connection over a real WebSocket bus', () => {
  const cleanups: Array<() => void | Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  /**
   * Start an authenticated server bus with a subscriber on `hook:git.received`.
   * @returns Server, URL and the payloads the subscriber has seen.
   */
  async function startServer() {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    cleanups.push(async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', () => resolve());
      wss.once('error', reject);
    });
    const address = wss.address();
    if (address === null || typeof address === 'string') throw new Error('Expected TCP server address');

    const bus = createBusInstance({
      transports: [new ServerTransport({ websocket: wss, auth: new HmacAuth({ secret: SECRET }) })],
    });
    const namespace = bus.registerNamespace(createInboundHookNamespace('git'));
    const seen: RawInboundHookPayload[] = [];
    cleanups.push(
      bus.on(namespace.subjects.received, ({ payload }) => {
        seen.push(payload);
      }),
    );
    await bus.connect();
    cleanups.push(() => bus.disconnect());
    return { wss, seen, port: address.port, busUrl: `ws://127.0.0.1:${address.port}` };
  }

  const payload = (eventName: string): RawInboundHookPayload => ({
    eventName,
    receivedAt: 1,
    argv: [],
    stdinText: '',
    payload: { ok: true },
  });

  it('connects, delivers an emitted event to the server subscriber, and disconnects on dispose', async () => {
    const server = await startServer();
    const connection = await connectFastHookBus({
      name: 'hook-git',
      busUrl: server.busUrl,
      secret: SECRET,
      timeoutMs: CONNECT_TIMEOUT_MS,
    });
    expect(connection).not.toBeNull();
    if (!connection) return;
    cleanups.push(() => connection.dispose());
    expect(server.wss.clients.size).toBe(1);

    await emitInboundHookReceived(connection.bus, 'git', payload('post-commit'), { failOpen: false });
    await vi.waitFor(() => expect(server.seen).toHaveLength(1));
    expect(server.seen[0]?.eventName).toBe('post-commit');

    connection.dispose();
    await vi.waitFor(() => expect(server.wss.clients.size).toBe(0));
  });

  it('keeps real transport debug lines off stdout and console.info when debug is enabled', async () => {
    const server = await startServer();
    const prefix = '[WebSocketClientTransport';
    const stdoutSpy = vi.spyOn(process.stdout, 'write');
    const stderrSpy = vi.spyOn(process.stderr, 'write');
    const infoSpy = vi.spyOn(console, 'info');
    const writesContaining = (spy: { mock: { calls: unknown[][] } }, text: string) =>
      spy.mock.calls.filter(([chunk]) => String(chunk).includes(text));

    try {
      const connection = await connectFastHookBus({
        name: 'hook-git-debug',
        busUrl: server.busUrl,
        secret: SECRET,
        timeoutMs: CONNECT_TIMEOUT_MS,
        debug: true,
      });
      expect(connection).not.toBeNull();
      if (!connection) return;
      cleanups.push(() => connection.dispose());

      await vi.waitFor(() => {
        const lines = writesContaining(stderrSpy, prefix).filter(([chunk]) => String(chunk).includes('Connected to'));
        expect(lines.length).toBeGreaterThan(0);
      });

      expect(writesContaining(stdoutSpy, prefix)).toEqual([]);
      expect(infoSpy.mock.calls.filter((args) => args.some((arg) => String(arg).includes(prefix)))).toEqual([]);

      connection.dispose();
      await vi.waitFor(() => expect(server.wss.clients.size).toBe(0));
    } finally {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it('delivers one hook end to end with emitInboundHookReceivedFast', async () => {
    const server = await startServer();

    await emitInboundHookReceivedFast('git', payload('pre-push'), {
      busUrl: server.busUrl,
      secret: SECRET,
      timeoutMs: CONNECT_TIMEOUT_MS,
    });

    await vi.waitFor(() => expect(server.seen).toHaveLength(1));
    expect(server.seen[0]?.eventName).toBe('pre-push');
    await vi.waitFor(() => expect(server.wss.clients.size).toBe(0));
  });

  it('resolves null for a wrong secret within the deadline', async () => {
    const server = await startServer();
    const startedAt = Date.now();

    const connection = await connectFastHookBus({
      name: 'hook-git',
      busUrl: server.busUrl,
      secret: 'wrong-secret',
      timeoutMs: 300,
    });

    expect(connection).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await vi.waitFor(() => expect(server.wss.clients.size).toBe(0));
    expect(server.seen).toEqual([]);
  });

  it('resolves null for an unreachable port within the deadline', async () => {
    // Bind and close a server to obtain a port that is guaranteed to refuse connections.
    const probe = await startServer();
    const { busUrl } = probe;
    await probe.wss.close();
    const startedAt = Date.now();

    const connection = await connectFastHookBus({ name: 'hook-git', busUrl, secret: SECRET, timeoutMs: 300 });

    expect(connection).toBeNull();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
