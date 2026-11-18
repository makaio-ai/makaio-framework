/**
 * Integration tests for StdioServerTransport.
 *
 * All tests use a real Node.js child process — no mocks — to verify actual
 * stdio framing and bidirectional message flow.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { StdioServerTransport } from '../stdio-server-transport.js';
import type { BusMessage } from '@makaio/bus-core';

const TRANSPORT_INTEGRATION_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Minimal child-process script
//
// The child:
//   1. Emits `subscribe-sync-complete` immediately (no subscriptions to advertise)
//   2. Echoes every subsequent bus message it receives back to stdout, with
//      `echoed: true` added to the object
// ---------------------------------------------------------------------------
const CHILD_SCRIPT = `
process.stdin.resume();
process.stdin.setEncoding('utf-8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (line.trim()) {
      try {
        const msg = JSON.parse(line);
        // Don't echo control messages back — they would cause a ping-pong loop.
        if (msg.type !== 'subscribe' && msg.type !== 'unsubscribe' && msg.type !== 'subscribe-sync-complete') {
          process.stdout.write(JSON.stringify({ ...msg, echoed: true }) + '\\n');
        }
      } catch {}
    }
  }
});
// Signal ready immediately — no subjects to advertise.
process.stdout.write(JSON.stringify({ type: 'subscribe-sync-complete' }) + '\\n');
`;

const SPAWN_OPTIONS = {
  command: 'node',
  args: ['-e', CHILD_SCRIPT],
  cwd: process.cwd(),
  processName: 'test-child',
};

const DELAYED_HANDSHAKE_SCRIPT = `
process.stdin.resume();
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: 'subscribe-sync-complete' }) + '\\n');
}, 50);
`;

const MALFORMED_BEFORE_HANDSHAKE_SCRIPT = `
process.stdin.resume();
process.stdout.write('not-json\\n');
process.stdout.write(JSON.stringify({ type: 'subscribe-sync-complete' }) + '\\n');
`;

const MALFORMED_BEFORE_RESPONSE_SCRIPT = `
process.stdin.resume();
process.stdin.setEncoding('utf-8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === 'request') {
      process.stdout.write('not-json\\n');
      process.stdout.write(JSON.stringify({ type: 'response', correlationId: msg.correlationId, result: 'answered' }) + '\\n');
    }
  }
});
process.stdout.write(JSON.stringify({ type: 'subscribe-sync-complete' }) + '\\n');
`;

// Answers the first request from a helper process that inherits stdout and
// writes after this child has exited cleanly, so the child's `exit` always
// precedes the response on stdout.
const ANSWER_AFTER_EXIT_SCRIPT = `
process.stdin.setEncoding('utf-8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\\n');
  buf = lines.pop() || '';
  const msg = lines.filter((line) => line.trim()).map((line) => JSON.parse(line)).find((m) => m.type === 'request');
  if (!msg) return;
  const response = JSON.stringify({ type: 'response', correlationId: msg.correlationId, result: 'answered' });
  require('node:child_process').spawn(
    process.execPath,
    ['-e', 'setTimeout(() => process.stdout.write(process.argv[1] + "\\\\n"), 100)', response],
    { stdio: ['ignore', 'inherit', 'ignore'] },
  );
  process.exit(0);
});
process.stdout.write(JSON.stringify({ type: 'subscribe-sync-complete' }) + '\\n');
`;

// Answers the first request, leaves a helper process holding the inherited
// stdout open, and ends the child with the given statement (a code exit or a
// self-inflicted signal). The child's `exit` therefore precedes stdout `close`
// by the helper's lifetime; the helper terminates itself after 3 seconds.
const answerThenEndHoldingStdoutScript = (endStatement: string): string => `
process.stdin.setEncoding('utf-8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\\n');
  buf = lines.pop() || '';
  const msg = lines.filter((line) => line.trim()).map((line) => JSON.parse(line)).find((m) => m.type === 'request');
  if (!msg) return;
  require('node:child_process').spawn(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 3000)'],
    { stdio: ['ignore', 'inherit', 'ignore'] },
  ).unref();
  process.stdout.write(JSON.stringify({ type: 'response', correlationId: msg.correlationId, result: 'answered' }) + '\\n');
  ${endStatement}
});
process.stdout.write(JSON.stringify({ type: 'subscribe-sync-complete' }) + '\\n');
`;

const CONTROL_OBSERVER_SCRIPT = `
process.stdin.resume();
process.stdin.setEncoding('utf-8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'unsubscribe') {
        process.stdout.write(JSON.stringify({
          type: 'event',
          subject: 'test.control',
          namespace: 'test',
          payload: msg,
          messageId: 'control-unsubscribe'
        }) + '\\n');
      }
    } catch {}
  }
});
process.stdout.write(JSON.stringify({ type: 'subscribe-sync-complete' }) + '\\n');
`;

const SUBSCRIBE_OBSERVER_SCRIPT = `
process.stdin.resume();
process.stdin.setEncoding('utf-8');
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  const lines = buf.split('\\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'subscribe') {
        process.stdout.write(JSON.stringify({
          type: 'event',
          subject: 'test.subscribe-control',
          namespace: 'test',
          payload: msg,
          messageId: 'control-subscribe'
        }) + '\\n');
      }
    } catch {}
  }
});
process.stdout.write(JSON.stringify({ type: 'subscribe-sync-complete' }) + '\\n');
`;

describe('StdioServerTransport', { timeout: TRANSPORT_INTEGRATION_TIMEOUT_MS }, () => {
  let transport: StdioServerTransport | undefined;

  afterEach(async () => {
    await transport?.disconnect();
    transport = undefined;
    vi.restoreAllMocks();
  });

  it('connect() spawns the child process and resolves', async () => {
    transport = new StdioServerTransport({ spawn: SPAWN_OPTIONS });
    await transport.connect();
    await transport.ready;
    expect(transport.isReady()).toBe(true);
  });

  it('ready promise resolves after subscribe-sync-complete handshake', async () => {
    transport = new StdioServerTransport({ spawn: SPAWN_OPTIONS });
    await transport.connect();

    // ready should resolve without any manual intervention
    await expect(transport.ready).resolves.toBeUndefined();
  });

  it('drops malformed output before the handshake and still becomes ready', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let disconnected = false;
    transport = new StdioServerTransport({
      spawn: {
        command: 'node',
        args: ['-e', MALFORMED_BEFORE_HANDSHAKE_SCRIPT],
        cwd: process.cwd(),
        processName: 'malformed-child',
      },
    });
    transport.onDisconnected = () => {
      disconnected = true;
    };

    await transport.connect();

    await expect(transport.ready).resolves.toBeUndefined();
    expect(transport.isReady()).toBe(true);
    expect(disconnected).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith('[malformed-child] dropped 1 malformed JSONL line(s) from stdout');
  });

  it('keeps pending correlations when malformed output precedes their response', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    transport = new StdioServerTransport({
      spawn: {
        command: 'node',
        args: ['-e', MALFORMED_BEFORE_RESPONSE_SCRIPT],
        cwd: process.cwd(),
        processName: 'malformed-child',
      },
    });

    await transport.connect();
    await transport.ready;

    const request: BusMessage = {
      type: 'request',
      subject: 'test.pending',
      namespace: 'test',
      payload: {},
      correlationId: 'corr-malformed',
      messageId: 'msg-malformed',
    };

    await expect(transport.send(request, 10_000)).resolves.toBe('answered');
    expect(transport.isReady()).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith('[malformed-child] dropped 1 malformed JSONL line(s) from stdout');
  });

  it('settles a correlation whose response is still on stdout when the child exits', async () => {
    transport = new StdioServerTransport({
      spawn: {
        command: 'node',
        args: ['-e', ANSWER_AFTER_EXIT_SCRIPT],
        cwd: process.cwd(),
        processName: 'answer-after-exit-child',
      },
    });

    await transport.connect();
    await transport.ready;

    const request: BusMessage = {
      type: 'request',
      subject: 'test.pending',
      namespace: 'test',
      payload: {},
      correlationId: 'corr-after-exit',
      messageId: 'msg-after-exit',
    };

    await expect(transport.send(request, 10_000)).resolves.toBe('answered');
  });

  it.each([
    { ending: 'a code exit', endStatement: 'process.exit(0);' },
    { ending: 'a signal exit', endStatement: "process.kill(process.pid, 'SIGTERM');" },
  ])('rejects send() once the child has ended by $ending while a descendant still holds stdout', async ({
    endStatement,
  }) => {
    transport = new StdioServerTransport({
      spawn: {
        command: 'node',
        args: ['-e', answerThenEndHoldingStdoutScript(endStatement)],
        cwd: process.cwd(),
        processName: 'exit-holding-stdout-child',
      },
    });
    let disconnected = false;
    transport.onDisconnected = () => {
      disconnected = true;
    };

    await transport.connect();
    await transport.ready;

    const request = (id: string): BusMessage => ({
      type: 'request',
      subject: 'test.pending',
      namespace: 'test',
      payload: {},
      correlationId: `corr-${id}`,
      messageId: `msg-${id}`,
    });

    // The response written before the exit still settles its correlation.
    await expect(transport.send(request('before-exit'), 10_000)).resolves.toBe('answered');

    // The helper keeps stdout open, so the session has not been terminated yet,
    // but the child is gone and nothing may be written or tracked any more.
    await vi.waitFor(() => expect(transport?.isReady()).toBe(false));
    expect(disconnected).toBe(false);
    await expect(transport.send(request('after-exit'), 200)).rejects.toThrow('not connected');
  });

  it(
    'creates a fresh ready session and reports it on reconnect',
    async () => {
      transport = new StdioServerTransport({
        spawn: {
          command: 'node',
          args: ['-e', DELAYED_HANDSHAKE_SCRIPT],
          cwd: process.cwd(),
          processName: 'delayed-child',
        },
      });

      await transport.connect();
      await transport.ready;
      await transport.disconnect();

      const sessions: Array<Promise<void>> = [];
      transport.onNewReadySession = (promise) => {
        sessions.push(promise);
      };

      await transport.connect();

      expect(sessions).toHaveLength(1);
      expect(transport.ready).toBe(sessions[0]);
      expect(transport.isReady()).toBe(false);

      await transport.ready;
      expect(transport.isReady()).toBe(true);
    },
    TRANSPORT_INTEGRATION_TIMEOUT_MS,
  );

  it('isReady() returns false before connect() is called', () => {
    transport = new StdioServerTransport({ spawn: SPAWN_OPTIONS });
    expect(transport.isReady()).toBe(false);
  });

  it('onReceive() receives messages sent by the child process', async () => {
    transport = new StdioServerTransport({ spawn: SPAWN_OPTIONS });
    await transport.connect();
    await transport.ready;

    const received: BusMessage[] = [];
    const transportNames: Array<string | undefined> = [];
    transport.onReceive(async (msg, context) => {
      received.push(msg);
      transportNames.push(context?.transportName);
    });

    // Trigger the child to emit by sending an event; child echoes it back.
    const testEvent: BusMessage = {
      type: 'event',
      subject: 'test.ping',
      namespace: 'test',
      payload: { hello: 'world' },
      messageId: 'msg-1',
    };
    await transport.send(testEvent);

    // Wait for the echo to arrive.
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (received.length >= 1) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    expect(received).toHaveLength(1);
    expect((received[0] as BusMessage & { echoed: boolean }).echoed).toBe(true);
    expect((received[0] as { subject: string }).subject).toBe('test.ping');
    expect(transportNames).toEqual(['stdio-server']);
  });

  it('send() delivers a message to the child process', async () => {
    transport = new StdioServerTransport({ spawn: SPAWN_OPTIONS });
    await transport.connect();
    await transport.ready;

    const received: BusMessage[] = [];
    transport.onReceive(async (msg) => {
      received.push(msg);
    });

    const testEvent: BusMessage = {
      type: 'event',
      subject: 'test.send-delivery',
      namespace: 'test',
      payload: { check: 42 },
      messageId: 'msg-2',
    };

    await transport.send(testEvent);

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (received.length >= 1) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    expect(received[0]).toMatchObject({ subject: 'test.send-delivery', payload: { check: 42 } });
  });

  it('disconnect() kills the child process', async () => {
    transport = new StdioServerTransport({ spawn: SPAWN_OPTIONS });
    await transport.connect();
    await transport.ready;

    await transport.disconnect();

    expect(transport.isReady()).toBe(false);
  });

  it('bidirectional message flow works end-to-end', async () => {
    transport = new StdioServerTransport({ spawn: SPAWN_OPTIONS });
    await transport.connect();
    await transport.ready;

    const received: Array<BusMessage & { echoed?: boolean }> = [];
    transport.onReceive(async (msg) => {
      received.push(msg as BusMessage & { echoed?: boolean });
    });

    const messages: BusMessage[] = [
      {
        type: 'event',
        subject: 'test.a',
        namespace: 'test',
        payload: { n: 1 },
        messageId: 'msg-a',
      },
      {
        type: 'event',
        subject: 'test.b',
        namespace: 'test',
        payload: { n: 2 },
        messageId: 'msg-b',
      },
      {
        type: 'event',
        subject: 'test.c',
        namespace: 'test',
        payload: { n: 3 },
        messageId: 'msg-c',
      },
    ];

    for (const msg of messages) {
      await transport.send(msg);
    }

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (received.length >= 3) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    expect(received).toHaveLength(3);
    expect(received.every((m) => m.echoed === true)).toBe(true);
    expect(received.map((m) => (m as { subject: string }).subject)).toEqual(['test.a', 'test.b', 'test.c']);
  });

  it('onReceive() returns an unsubscribe function that stops delivery', async () => {
    transport = new StdioServerTransport({ spawn: SPAWN_OPTIONS });
    await transport.connect();
    await transport.ready;

    const received: BusMessage[] = [];
    const unsub = transport.onReceive(async (msg) => {
      received.push(msg);
    });

    const firstEvent: BusMessage = {
      type: 'event',
      subject: 'test.unsub',
      namespace: 'test',
      payload: { n: 1 },
      messageId: 'msg-u1',
    };

    await transport.send(firstEvent);

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (received.length >= 1) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    unsub();

    // Send a second event after unsubscribing — should not arrive.
    const secondEvent: BusMessage = {
      type: 'event',
      subject: 'test.unsub',
      namespace: 'test',
      payload: { n: 2 },
      messageId: 'msg-u2',
    };
    await transport.send(secondEvent);

    // Short wait to ensure no second delivery happens.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    expect(received).toHaveLength(1);
  });

  it('subscribe() sends a subscribe message to the child process', async () => {
    transport = new StdioServerTransport({
      spawn: {
        command: 'node',
        args: ['-e', SUBSCRIBE_OBSERVER_SCRIPT],
        cwd: process.cwd(),
        processName: 'subscribe-observer-child',
      },
    });
    const received: BusMessage[] = [];
    transport.onReceive(async (message) => {
      received.push(message);
    });

    await transport.subscribe('test.subject', undefined, [100], 'first-hop-only');

    await transport.connect();
    await transport.ready;

    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
    });
    expect(received[0]).toMatchObject({
      type: 'event',
      payload: {
        type: 'subscribe',
        subjects: { 'test.subject': [100] },
        deliveryClasses: { 'test.subject': 'first-hop-only' },
      },
    });
  });

  it('unsubscribe() sends an unsubscribe message to the child process', async () => {
    transport = new StdioServerTransport({
      spawn: {
        command: 'node',
        args: ['-e', CONTROL_OBSERVER_SCRIPT],
        cwd: process.cwd(),
        processName: 'control-observer-child',
      },
    });
    await transport.connect();
    await transport.ready;

    const received: BusMessage[] = [];
    transport.onReceive(async (msg) => {
      received.push(msg);
    });

    await transport.subscribe('test.unsub-subject', undefined, [100]);

    await expect(transport.unsubscribe('test.unsub-subject')).resolves.toBeUndefined();

    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (received.length >= 1) {
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    expect(received[0]).toMatchObject({
      type: 'event',
      payload: {
        type: 'unsubscribe',
        subjects: { 'test.unsub-subject': [] },
      },
    });
  });
});
