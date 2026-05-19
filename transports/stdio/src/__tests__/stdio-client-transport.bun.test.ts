/**
 * Unit tests for `StdioClientTransport`.
 *
 * Uses injectable `PassThrough` streams to avoid touching real stdio and to
 * drive the subscribe-sync handshake synchronously in-process.
 */

import { PassThrough, Readable } from 'node:stream';
import { describe, it, expect, afterEach, mock } from 'bun:test';
import { StdioClientTransport } from '../stdio-client-transport.js';
import { encodeBusMessage } from '../stdio-framing.js';
import type { BusMessage, BusEventMessage, BusRequestMessage } from '@makaio/bus-core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a pair of connected PassThrough streams and a `StdioClientTransport`
 * wired to them.
 *
 * Returns:
 * - `transport` — the transport under test
 * - `hostIn` — what the "host" writes to; the transport reads from it
 * - `hostOut` — what the "host" reads from; the transport writes to it
 */
function createTestTransport(): {
  transport: StdioClientTransport;
  hostIn: PassThrough;
  hostOut: PassThrough;
} {
  // hostIn is what we (the test, acting as host) write bus messages into.
  // The transport reads from it as its stdin.
  const hostIn = new PassThrough();

  // hostOut is where the transport writes its messages.
  // The test reads from it as if it were the host reading from the child's stdout.
  const hostOut = new PassThrough();

  const transport = new StdioClientTransport({ stdin: hostIn, stdout: hostOut });

  return { transport, hostIn, hostOut };
}

/**
 * Collect all data written to a PassThrough stream and split it into JSONL lines.
 * Resolves when `count` complete newline-terminated lines have been collected.
 * @param stream - The stream to read from
 * @param count - Number of JSONL lines to collect
 * @returns Parsed objects from each line
 */
function collectLines(stream: PassThrough, count: number): Promise<unknown[]> {
  return new Promise<unknown[]>((resolve, reject) => {
    const lines: unknown[] = [];
    let buffer = '';

    const cleanup = (): void => {
      stream.off('data', onData);
      stream.off('error', onError);
      stream.off('end', onEnd);
      stream.off('close', onClose);
    };

    const onData = (chunk: Buffer | string): void => {
      try {
        buffer += chunk.toString();
        const parts = buffer.split('\n');
        buffer = parts.pop() ?? '';

        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          lines.push(JSON.parse(trimmed));
          if (lines.length === count) {
            cleanup();
            resolve(lines);
            return;
          }
        }
      } catch (error) {
        cleanup();
        reject(error);
      }
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const onEnd = (): void => {
      cleanup();
      reject(new Error(`Stream ended before collecting ${count} JSONL lines`));
    };
    const onClose = onEnd;

    stream.on('data', onData);
    stream.on('error', onError);
    stream.on('end', onEnd);
    stream.on('close', onClose);
  });
}

/**
 * Send a raw JSON object as a JSONL line into the given PassThrough stream.
 * Simulates the host writing a message to the child's stdin.
 * @param stream - The stream to write into
 * @param message - Object to encode and write
 */
function sendToTransport(stream: PassThrough, message: object): void {
  stream.write(encodeBusMessage(message));
}

/**
 * Readable that emits the host sync-complete line synchronously from resume().
 * This catches connect-order regressions where data listeners are installed
 * after resuming stdin.
 */
class ResumeHandshakeStream extends Readable {
  private emitted = false;

  /** No-op pull implementation; resume() emits the test payload directly. */
  public override _read(): void {}

  /**
   * Emit sync-complete immediately when the transport resumes stdin.
   * @returns This stream instance.
   */
  public override resume(): this {
    if (!this.emitted) {
      this.emitted = true;
      this.emit('data', encodeBusMessage({ type: 'subscribe-sync-complete' }));
    }
    return super.resume();
  }
}

/**
 * Connect the transport and complete the subscribe-sync handshake.
 *
 * 1. Calls `connect()` (transport sends subscribe-sync-complete to hostOut).
 * 2. Sends subscribe-sync-complete from host into hostIn so `ready` resolves.
 * @param transport - Transport to connect
 * @param hostIn - Host-side stdin stream
 * @param hostOut - Host-side stdout stream
 */
async function connectAndSync(
  transport: StdioClientTransport,
  hostIn: PassThrough,
  hostOut: PassThrough,
): Promise<void> {
  const syncPromise = collectLines(hostOut, 1);
  await transport.connect();

  // Wait for the transport's subscribe-sync-complete to arrive.
  const [syncMsg] = await syncPromise;
  expect((syncMsg as { type: string }).type).toBe('subscribe-sync-complete');

  // Simulate the host sending subscribe-sync-complete back.
  sendToTransport(hostIn, { type: 'subscribe-sync-complete' });
  await transport.ready;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StdioClientTransport', () => {
  const transports: StdioClientTransport[] = [];

  afterEach(async () => {
    for (const t of transports) {
      void t.ready.catch(() => undefined);
      await t.disconnect().catch(() => undefined);
    }
    transports.length = 0;
  });

  describe('connect()', () => {
    it('sends subscribe-sync-complete to stdout on connect', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      const linesPromise = collectLines(hostOut, 1);
      await transport.connect();

      const [message] = await linesPromise;
      expect(message).toEqual({ type: 'subscribe-sync-complete' });

      hostIn.end();
    });

    it('attaches stdin listeners before resume() emits buffered handshake data', async () => {
      const hostIn = new ResumeHandshakeStream();
      const hostOut = new PassThrough();
      const transport = new StdioClientTransport({ stdin: hostIn, stdout: hostOut });
      transports.push(transport);

      const linesPromise = collectLines(hostOut, 1);

      await transport.connect();
      await transport.ready;

      const [message] = await linesPromise;
      expect(message).toEqual({ type: 'subscribe-sync-complete' });
      expect(transport.isReady()).toBe(true);
    });

    it('throws when connect() is called a second time', async () => {
      const { transport, hostIn } = createTestTransport();
      transports.push(transport);

      await transport.connect();
      await expect(transport.connect()).rejects.toThrow(/already connected/i);

      hostIn.end();
    });
  });

  describe('ready', () => {
    it('resolves the ready promise after receiving subscribe-sync-complete from stdin', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      await transport.connect();

      // Drain the transport's own sync-complete so we don't block.
      void collectLines(hostOut, 1);

      let readyResolved = false;
      void transport.ready
        .then(() => {
          readyResolved = true;
        })
        .catch(() => undefined);

      // Simulate host sending sync-complete.
      sendToTransport(hostIn, { type: 'subscribe-sync-complete' });

      await transport.ready;
      expect(readyResolved).toBe(true);

      hostIn.end();
    });

    it('ignores duplicate subscribe-sync-complete frames after the first connection callback', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      const onConnected = mock();
      transport.onConnected = onConnected;

      await connectAndSync(transport, hostIn, hostOut);
      sendToTransport(hostIn, { type: 'subscribe-sync-complete' });

      expect(onConnected).toHaveBeenCalledOnce();

      hostIn.end();
    });

    it('ready is not resolved before sync-complete arrives', async () => {
      const { transport, hostOut } = createTestTransport();
      transports.push(transport);

      void collectLines(hostOut, 1);
      await transport.connect();

      let readyResolved = false;
      void transport.ready
        .then(() => {
          readyResolved = true;
        })
        .catch(() => undefined);

      await Promise.resolve();
      expect(readyResolved).toBe(false);
    });

    it('rejects ready when disconnect() runs before sync-complete arrives', async () => {
      const { transport, hostOut } = createTestTransport();
      transports.push(transport);

      void collectLines(hostOut, 1);
      await transport.connect();

      const ready = transport.ready.catch((error: unknown) => error);
      await transport.disconnect();
      const error = await ready;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('disconnected before subscribe-sync-complete');
    });

    it('rejects ready when stdin ends before sync-complete arrives', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      void collectLines(hostOut, 1);
      await transport.connect();

      const ready = transport.ready.catch((error: unknown) => error);
      hostIn.end();
      const error = await ready;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('disconnected before subscribe-sync-complete');
    });

    it('creates a fresh ready session and reports it on reconnect', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      await connectAndSync(transport, hostIn, hostOut);
      const firstReady = transport.ready;

      await transport.disconnect();

      const sessions: Array<Promise<void>> = [];
      transport.onNewReadySession = (promise) => {
        sessions.push(promise);
      };

      const syncPromise = collectLines(hostOut, 1);
      await transport.connect();
      await syncPromise;

      expect(sessions).toHaveLength(1);
      expect(transport.ready).toBe(sessions[0]);
      expect(transport.ready).not.toBe(firstReady);
      expect(transport.isReady()).toBe(false);

      sendToTransport(hostIn, { type: 'subscribe-sync-complete' });

      await transport.ready;
      expect(transport.isReady()).toBe(true);

      hostIn.end();
    });
  });

  describe('send()', () => {
    it('writes a bus message as JSONL to stdout', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      await connectAndSync(transport, hostIn, hostOut);

      const sentPromise = collectLines(hostOut, 1);

      const event: BusEventMessage = {
        type: 'event',
        subject: 'test.subject',
        namespace: 'test',
        payload: { x: 42 },
        messageId: 'msg-1',
      };
      await transport.send(event);

      const [written] = await sentPromise;
      expect(written).toEqual(event);

      hostIn.end();
    });

    it('throws when send() is called before connect()', async () => {
      const { transport } = createTestTransport();
      transports.push(transport);

      const event: BusEventMessage = {
        type: 'event',
        subject: 'test.subject',
        namespace: 'test',
        payload: {},
        messageId: 'msg-1',
      };

      await expect(transport.send(event)).rejects.toThrow(/not connected/i);
    });
  });

  describe('onReceive()', () => {
    it('delivers parsed messages from stdin to registered handlers', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      await connectAndSync(transport, hostIn, hostOut);

      const received: BusMessage[] = [];
      transport.onReceive(async (msg) => {
        received.push(msg);
      });

      const event: BusEventMessage = {
        type: 'event',
        subject: 'adapter.init',
        namespace: 'adapter',
        payload: { name: 'test-adapter' },
        messageId: 'evt-1',
      };

      sendToTransport(hostIn, event);

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(event);

      hostIn.end();
    });

    it('supports multiple onReceive handlers', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      await connectAndSync(transport, hostIn, hostOut);

      const first: BusMessage[] = [];
      const second: BusMessage[] = [];

      transport.onReceive(async (msg) => {
        first.push(msg);
      });
      transport.onReceive(async (msg) => {
        second.push(msg);
      });

      const event: BusEventMessage = {
        type: 'event',
        subject: 'test.event',
        namespace: 'test',
        payload: {},
        messageId: 'evt-2',
      };
      sendToTransport(hostIn, event);

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);

      hostIn.end();
    });

    it('continues fan-out when a handler throws synchronously', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      await connectAndSync(transport, hostIn, hostOut);

      const received: BusMessage[] = [];
      transport.onReceive(() => {
        throw new Error('handler failed');
      });
      transport.onReceive(async (msg) => {
        received.push(msg);
      });

      const event: BusEventMessage = {
        type: 'event',
        subject: 'test.event',
        namespace: 'test',
        payload: {},
        messageId: 'evt-sync-throw',
      };
      sendToTransport(hostIn, event);

      expect(received).toEqual([event]);

      hostIn.end();
    });

    it('returns an unsubscribe function that stops delivery', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      await connectAndSync(transport, hostIn, hostOut);

      const received: BusMessage[] = [];
      const unsubscribe = transport.onReceive(async (msg) => {
        received.push(msg);
      });

      const event: BusEventMessage = {
        type: 'event',
        subject: 'test.event',
        namespace: 'test',
        payload: {},
        messageId: 'evt-3',
      };
      sendToTransport(hostIn, event);
      expect(received).toHaveLength(1);

      unsubscribe();

      sendToTransport(hostIn, { ...event, messageId: 'evt-4' });
      expect(received).toHaveLength(1); // No new message delivered.

      hostIn.end();
    });

    it('does not forward subscribe-sync-complete to application handlers', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      void collectLines(hostOut, 1);
      await transport.connect();

      const received: BusMessage[] = [];
      transport.onReceive(async (msg) => {
        received.push(msg);
      });

      sendToTransport(hostIn, { type: 'subscribe-sync-complete' });
      await transport.ready;

      expect(received).toHaveLength(0);

      hostIn.end();
    });

    it('does not forward heartbeat messages to application handlers', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      await connectAndSync(transport, hostIn, hostOut);

      const received: BusMessage[] = [];
      transport.onReceive(async (msg) => {
        received.push(msg);
      });

      sendToTransport(hostIn, { type: 'heartbeat', timestamp: Date.now() });

      expect(received).toHaveLength(0);

      hostIn.end();
    });

    it('reports malformed input instead of silently dropping it', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      await connectAndSync(transport, hostIn, hostOut);

      const errors: Error[] = [];
      const unsubscribe = transport.onError((error) => {
        errors.push(error);
      });

      hostIn.write('not-json\n');

      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain('Failed to parse stdio JSONL');

      unsubscribe();
      hostIn.end();
    });

    it('reports valid JSON that is not a bus message envelope', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      await connectAndSync(transport, hostIn, hostOut);

      const errors: Error[] = [];
      const unsubscribe = transport.onError((error) => {
        errors.push(error);
      });

      hostIn.write('{"hello":"world"}\n');

      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toBe('Received malformed stdio bus message');

      unsubscribe();
      hostIn.end();
    });

    it('continues error fan-out when an error observer throws', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      await connectAndSync(transport, hostIn, hostOut);

      transport.onError(() => {
        throw new Error('observer failed');
      });
      const laterObserver = mock();
      transport.onError(laterObserver);

      hostIn.write('not-json\n');

      expect(laterObserver).toHaveBeenCalledOnce();

      hostIn.end();
    });
  });

  describe('subscribe() / unsubscribe()', () => {
    it('subscribe() writes a subscribe message to stdout', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      await connectAndSync(transport, hostIn, hostOut);

      const linesPromise = collectLines(hostOut, 1);
      await transport.subscribe('adapter.*', undefined, [100, 200]);

      const [written] = await linesPromise;
      expect(written).toEqual({
        type: 'subscribe',
        subjects: { 'adapter.*': [100, 200] },
      });

      hostIn.end();
    });

    it('subscribe() includes filter when provided', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      await connectAndSync(transport, hostIn, hostOut);

      const linesPromise = collectLines(hostOut, 1);
      await transport.subscribe('mcp.event', { agentId: 'agent-1' });

      const [written] = await linesPromise;
      expect(written).toEqual({
        type: 'subscribe',
        subjects: { 'mcp.event': [] },
        filters: { 'mcp.event': { agentId: 'agent-1' } },
      });

      hostIn.end();
    });

    it('unsubscribe() writes an unsubscribe message to stdout', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      await connectAndSync(transport, hostIn, hostOut);

      const linesPromise = collectLines(hostOut, 1);
      await transport.unsubscribe('adapter.*');

      const [written] = await linesPromise;
      expect(written).toEqual({
        type: 'unsubscribe',
        subjects: { 'adapter.*': [] },
      });

      hostIn.end();
    });
  });

  describe('disconnect()', () => {
    it('pauses stdin and cleans up without calling process.exit()', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      await connectAndSync(transport, hostIn, hostOut);

      await transport.disconnect();

      // After disconnect, sending a message should throw.
      const event: BusEventMessage = {
        type: 'event',
        subject: 'test.subject',
        namespace: 'test',
        payload: {},
        messageId: 'msg-post-disconnect',
      };
      await expect(transport.send(event)).rejects.toThrow(/not connected/i);

      hostIn.end();
    });

    it('is idempotent (disconnect() on already-disconnected transport is a no-op)', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      await connectAndSync(transport, hostIn, hostOut);
      await transport.disconnect();
      await expect(transport.disconnect()).resolves.toBeUndefined();

      hostIn.end();
    });

    it('messages arriving after disconnect() are ignored', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      await connectAndSync(transport, hostIn, hostOut);

      const received: BusMessage[] = [];
      transport.onReceive(async (msg) => {
        received.push(msg);
      });

      await transport.disconnect();

      // Write a message after disconnect; listeners have been removed so it
      // should not reach the handler.
      sendToTransport(hostIn, {
        type: 'event',
        subject: 'test.subject',
        namespace: 'test',
        payload: {},
        messageId: 'ignored',
      } satisfies BusEventMessage);

      expect(received).toHaveLength(0);

      hostIn.end();
    });
  });

  describe('correlation (request/response round-trip)', () => {
    it('resolves send() for a request message when a matching response arrives', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      await connectAndSync(transport, hostIn, hostOut);

      // Drain the request line from hostOut.
      const outPromise = collectLines(hostOut, 1);

      const request: BusRequestMessage = {
        type: 'request',
        subject: 'test.handler',
        namespace: 'test',
        payload: { q: 'hello' },
        correlationId: 'corr-1',
        messageId: 'msg-req-1',
      };

      const sendPromise = transport.send(request, 1000);

      await outPromise; // Ensure request was written.

      // Simulate the host sending back a response.
      sendToTransport(hostIn, {
        type: 'response',
        correlationId: 'corr-1',
        result: { answer: 42 },
      });

      const result = await sendPromise;
      expect(result).toEqual({ answer: 42 });

      hostIn.end();
    });
  });

  describe('isReady()', () => {
    it('returns false before connect()', () => {
      const { transport } = createTestTransport();
      transports.push(transport);

      expect(transport.isReady()).toBe(false);
    });

    it('returns false after connect() before handshake', async () => {
      const { transport, hostIn } = createTestTransport();
      transports.push(transport);

      await transport.connect();
      expect(transport.isReady()).toBe(false);

      hostIn.end();
    });

    it('returns true after subscribe-sync handshake completes', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      await connectAndSync(transport, hostIn, hostOut);
      expect(transport.isReady()).toBe(true);

      hostIn.end();
    });

    it('returns false after disconnect()', async () => {
      const { transport, hostIn, hostOut } = createTestTransport();
      transports.push(transport);

      await connectAndSync(transport, hostIn, hostOut);
      await transport.disconnect();

      expect(transport.isReady()).toBe(false);

      hostIn.end();
    });
  });
});
