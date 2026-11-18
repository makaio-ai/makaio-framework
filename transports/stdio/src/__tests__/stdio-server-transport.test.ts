/**
 * Integration tests for StdioServerTransport.
 *
 * All tests use a real Node.js child process — no mocks — to verify actual
 * stdio framing and bidirectional message flow.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { StdioServerTransport } from '../stdio-server-transport.js';
import type { BusMessage } from '@makaio/bus-core';
import type { ProcessStopTiming } from '@makaio/subprocess';

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

// Exits at once and leaves a helper on stdout that writes the handshake after
// the exit, so the handshake arrives while the session no longer accepts writes.
const HANDSHAKE_AFTER_EXIT_SCRIPT = `
const handshake = JSON.stringify({ type: 'subscribe-sync-complete' });
require('node:child_process').spawn(
  process.execPath,
  ['-e', 'setTimeout(() => process.stdout.write(process.argv[1] + "\\\\n"), 100)', handshake],
  { stdio: ['ignore', 'inherit', 'ignore'] },
);
process.exit(0);
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

  it('accepts a handshake written after the child exited without replying to it', async () => {
    transport = new StdioServerTransport({
      spawn: {
        command: 'node',
        args: ['-e', HANDSHAKE_AFTER_EXIT_SCRIPT],
        cwd: process.cwd(),
        processName: 'handshake-after-exit-child',
      },
    });
    const disconnected = Promise.withResolvers<void>();
    transport.onDisconnected = () => disconnected.resolve();

    await transport.connect();
    await transport.ready;

    // The session stopped accepting writes at the exit, so it is not ready
    // although the handshake completed, and it ends once its stdout drained.
    expect(transport.isReady()).toBe(false);
    await disconnected.promise;
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

// ---------------------------------------------------------------------------
// Session end
//
// Children that report a pid write it as a bus event, so a test can check that
// the process is gone (or clean it up) after the session ended.
// ---------------------------------------------------------------------------

const HANDSHAKE_LINE = "JSON.stringify({ type: 'subscribe-sync-complete' })";

/**
 * Build a statement writing a bus event that names a process.
 * @param pidExpression - Script expression evaluating to the pid.
 * @returns Script source writing `{ type: 'event', subject: 'test.pid', payload: { pid } }`.
 */
function writePidEvent(pidExpression: string): string {
  return `process.stdout.write(JSON.stringify({ type: 'event', subject: 'test.pid', namespace: 'test', payload: { pid: ${pidExpression} }, messageId: 'pid' }) + '\\n');`;
}

/** Completes the handshake and exits cleanly once it reached the pipe. */
const EXIT_AFTER_HANDSHAKE_SCRIPT = `
process.stdout.write(${HANDSHAKE_LINE} + '\\n', () => process.exit(0));
`;

/** Exits with code 1 before any handshake. */
const EXIT_BEFORE_HANDSHAKE_SCRIPT = 'process.exit(1);';

/** Reports its pid, completes the handshake, closes stdout and keeps running. */
const CLOSE_STDOUT_AFTER_HANDSHAKE_SCRIPT = `
process.stdin.resume();
${writePidEvent('process.pid')}
process.stdout.write(${HANDSHAKE_LINE} + '\\n', () => require('node:fs').closeSync(1));
setInterval(() => {}, 1000);
`;

/** Completes the handshake, writes one event and exits cleanly once both reached the pipe. */
const EVENT_THEN_EXIT_SCRIPT = `
const event = JSON.stringify({ type: 'event', subject: 'test.last', namespace: 'test', payload: {}, messageId: 'last' });
process.stdout.write(${HANDSHAKE_LINE} + '\\n' + event + '\\n', () => process.exit(0));
`;

/**
 * Completes the handshake and exits, leaving a helper on stdout for a while, so
 * the session stays in its draining phase after the exit.
 */
const EXIT_WITH_HELD_STDOUT_SCRIPT = `
require('node:child_process')
  .spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], { stdio: ['ignore', 'inherit', 'ignore'] })
  .unref();
process.stdout.write(${HANDSHAKE_LINE} + '\\n', () => process.exit(0));
`;

/** Reports its pid and never completes the handshake. */
const NEVER_HANDSHAKE_SCRIPT = `
process.stdin.resume();
${writePidEvent('process.pid')}
setInterval(() => {}, 1000);
`;

/** Starts a grandchild holding no stdio, reports it, completes the handshake and stays. */
const GRANDCHILD_SCRIPT = `
process.stdin.resume();
const grandchild = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
grandchild.unref();
${writePidEvent('grandchild.pid')}
process.stdout.write(${HANDSHAKE_LINE} + '\\n');
setInterval(() => {}, 1000);
`;

/** Ignores SIGTERM, reports its pid, completes the handshake and stays. */
const IGNORE_SIGTERM_SCRIPT = `
process.stdin.resume();
process.on('SIGTERM', () => {});
${writePidEvent('process.pid')}
process.stdout.write(${HANDSHAKE_LINE} + '\\n');
setInterval(() => {}, 1000);
`;

/**
 * Starts a grandchild in its process group that ignores SIGTERM, reports it once
 * the grandchild armed its handler, completes the handshake and stays. The child
 * itself dies on SIGTERM, like a launcher in front of a stubborn process.
 */
const STUBBORN_GRANDCHILD_SCRIPT = `
process.stdin.resume();
const grandchild = require('node:child_process').spawn(
  process.execPath,
  ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('armed'); setInterval(() => {}, 1000);"],
  { stdio: ['ignore', 'pipe', 'ignore'] },
);
grandchild.unref();
grandchild.stdout.once('data', () => {
  grandchild.stdout.destroy();
  ${writePidEvent('grandchild.pid')}
  process.stdout.write(${HANDSHAKE_LINE} + '\\n');
});
setInterval(() => {}, 1000);
`;

/**
 * Build a child that completes the handshake, writes `finalLine` without a
 * terminating newline and exits cleanly.
 * @param finalLine - Script expression for the unterminated final line.
 * @returns Script source.
 */
function unterminatedFinalLineScript(finalLine: string): string {
  return `process.stdout.write(${HANDSHAKE_LINE} + '\\n' + ${finalLine}, () => process.exit(0));`;
}

/**
 * Report whether a process still exists. An unreaped zombie still counts, so a
 * check right after a stop polls until the process is reaped.
 * @param pid - Process to probe.
 * @returns `false` once the process is gone.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && 'code' in error && error.code === 'ESRCH');
  }
}

/**
 * Create a transport for `script` that records every received message and every
 * `onDisconnected` call.
 * @param processName - Diagnostic process name.
 * @param script - Child source for `node -e`.
 * @param options - Stop ownership (`terminateTree`) and stop timing (`stopTiming`) of the session's child.
 * @returns The transport and what it recorded.
 */
function observedTransport(
  processName: string,
  script: string,
  options: { readonly terminateTree?: boolean; readonly stopTiming?: ProcessStopTiming } = {},
): {
  transport: StdioServerTransport;
  received: BusMessage[];
  events: string[];
  reportedPid: Promise<number>;
} {
  const transport = new StdioServerTransport({
    spawn: { command: process.execPath, args: ['-e', script], cwd: process.cwd(), processName },
    ...options,
  });
  const received: BusMessage[] = [];
  const events: string[] = [];
  const pid = Promise.withResolvers<number>();
  transport.onReceive(async (message) => {
    received.push(message);
    events.push(`received:${message.type}`);
    if ('subject' in message && message.subject === 'test.pid') {
      pid.resolve((message.payload as { pid: number }).pid);
    }
  });
  transport.onDisconnected = () => events.push('disconnected');
  return { transport, received, events, reportedPid: pid.promise };
}

/**
 * Wait until `events` holds `count` disconnects, then a little longer so a
 * second report would have arrived.
 * @param events - Events recorded by {@link observedTransport}.
 * @param count - Expected number of disconnects.
 */
async function settledDisconnects(events: string[], count = 1): Promise<void> {
  await vi.waitFor(() => expect(events.filter((event) => event === 'disconnected')).toHaveLength(count), {
    timeout: 15_000,
    interval: 10,
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
}

describe('StdioServerTransport session end', { timeout: TRANSPORT_INTEGRATION_TIMEOUT_MS }, () => {
  let transport: StdioServerTransport | undefined;
  const strayPids = new Set<number>();

  afterEach(async () => {
    await transport?.disconnect();
    transport = undefined;
    for (const pid of strayPids) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    strayPids.clear();
    vi.restoreAllMocks();
  });

  it('ends the session as terminal when the child exits 0 after the handshake, reporting it once', async () => {
    const observed = observedTransport('exit-after-handshake-child', EXIT_AFTER_HANDSHAKE_SCRIPT);
    transport = observed.transport;

    await transport.connect();
    await transport.ready;
    await settledDisconnects(observed.events);

    expect(transport.isReady()).toBe(false);
    await expect(transport.send({ type: 'heartbeat', timestamp: Date.now() })).rejects.toThrow('not connected');
  });

  it('isolates a throwing onDisconnected on an unexpected end: logged, no unhandled rejection, session ended', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const observed = observedTransport('throwing-observer-child', EXIT_AFTER_HANDSHAKE_SCRIPT);
      transport = observed.transport;
      const observerFailure = new Error('observer failed');
      transport.onDisconnected = () => {
        observed.events.push('disconnected');
        throw observerFailure;
      };

      await transport.connect();
      await transport.ready;
      await settledDisconnects(observed.events);

      expect(unhandled).toEqual([]);
      expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('onDisconnected observer threw'), observerFailure);
      expect(transport.isReady()).toBe(false);
      await expect(transport.send({ type: 'heartbeat', timestamp: Date.now() })).rejects.toThrow('not connected');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('rejects the ready session with the end when the child exits before the handshake', async () => {
    const observed = observedTransport('exit-before-handshake-child', EXIT_BEFORE_HANDSHAKE_SCRIPT);
    transport = observed.transport;

    await transport.connect();

    await expect(transport.ready).rejects.toThrow('exit-before-handshake-child ended unexpectedly: exited with code 1');
    await settledDisconnects(observed.events);
  });

  it('ends a session whose child closed stdout after the drain deadline, and stops the child', async () => {
    const observed = observedTransport('closed-stdout-child', CLOSE_STDOUT_AFTER_HANDSHAKE_SCRIPT, {
      stopTiming: { drainTimeoutMs: 300 },
    });
    transport = observed.transport;

    await transport.connect();
    await transport.ready;
    const pid = await observed.reportedPid;
    strayPids.add(pid);

    await settledDisconnects(observed.events);

    await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
  });

  it('resolves the pending handshake on disconnect(), stops the child and reports no disconnect', async () => {
    const observed = observedTransport('never-ready-child', NEVER_HANDSHAKE_SCRIPT);
    transport = observed.transport;

    await transport.connect();
    const pid = await observed.reportedPid;
    strayPids.add(pid);

    await transport.disconnect();

    await expect(transport.ready).resolves.toBeUndefined();
    expect(isAlive(pid)).toBe(false);
    expect(observed.events).not.toContain('disconnected');
  });

  it('parses an unterminated final line at the end of stdout and delivers it before the session ends', async () => {
    const observed = observedTransport(
      'final-line-child',
      unterminatedFinalLineScript(
        "JSON.stringify({ type: 'event', subject: 'test.last', namespace: 'test', payload: {}, messageId: 'last' })",
      ),
    );
    transport = observed.transport;

    await transport.connect();
    await transport.ready;
    await settledDisconnects(observed.events);

    expect(observed.events).toEqual(['received:event', 'disconnected']);
    expect(observed.received[0]).toMatchObject({ subject: 'test.last' });
  });

  it('hands the last message to every handler before the session ends, also behind a slow handler', async () => {
    transport = new StdioServerTransport({
      spawn: { command: process.execPath, args: ['-e', EVENT_THEN_EXIT_SCRIPT], cwd: process.cwd() },
    });
    const events: string[] = [];
    transport.onReceive(async (message) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      events.push(`slow:${message.type}`);
    });
    transport.onReceive(async (message) => {
      events.push(`fast:${message.type}`);
    });
    transport.onDisconnected = () => events.push('disconnected');

    await transport.connect();
    await transport.ready;
    await settledDisconnects(events);
    await vi.waitFor(() => expect(events).toContain('slow:event'));

    expect(events.indexOf('fast:event')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('fast:event')).toBeLessThan(events.indexOf('disconnected'));
  });

  it('buffers subscription changes while the session drains after the exit, without throwing', async () => {
    const observed = observedTransport('draining-child', EXIT_WITH_HELD_STDOUT_SCRIPT);
    transport = observed.transport;

    await transport.connect();
    await transport.ready;
    await vi.waitFor(() => expect(transport?.isReady()).toBe(false));
    expect(observed.events).not.toContain('disconnected');

    await expect(transport.subscribe('test.later')).resolves.toBeUndefined();
    await expect(transport.unsubscribe('test.later')).resolves.toBeUndefined();
    await expect(transport.send({ type: 'heartbeat', timestamp: Date.now() })).rejects.toThrow('not connected');
    await settledDisconnects(observed.events);
  });

  it('discards an unterminated final line that is not a bus message object', async () => {
    const observed = observedTransport('final-scalar-child', unterminatedFinalLineScript("'42'"));
    transport = observed.transport;

    await transport.connect();
    await transport.ready;
    await settledDisconnects(observed.events);

    expect(observed.events).toEqual(['disconnected']);
  });

  it.skipIf(process.platform === 'win32')('stops the grandchild together with the child on disconnect()', async () => {
    const observed = observedTransport('grandchild-parent', GRANDCHILD_SCRIPT);
    transport = observed.transport;

    await transport.connect();
    await transport.ready;
    const grandchild = await observed.reportedPid;
    strayPids.add(grandchild);

    await transport.disconnect();

    await vi.waitFor(() => expect(isAlive(grandchild)).toBe(false));
    expect(observed.events).not.toContain('disconnected');
  });

  // Windows has no process groups: `taskkill /T /F` ends the tree in one stage.
  it.runIf(process.platform === 'win32')('stops the grandchild with the child on disconnect() on Windows', async () => {
    const observed = observedTransport('windows-grandchild-parent', GRANDCHILD_SCRIPT);
    transport = observed.transport;

    await transport.connect();
    await transport.ready;
    const grandchild = await observed.reportedPid;
    strayPids.add(grandchild);

    await transport.disconnect();

    await vi.waitFor(() => expect(isAlive(grandchild)).toBe(false));
  });

  it('bounds disconnect() by its stop timing for a child that ignores SIGTERM', async () => {
    const observed = observedTransport('stubborn-child', IGNORE_SIGTERM_SCRIPT, { stopTiming: { killGraceMs: 200 } });
    transport = observed.transport;

    await transport.connect();
    await transport.ready;
    const pid = await observed.reportedPid;
    strayPids.add(pid);
    const disconnectAt = Date.now();

    await transport.disconnect();

    // The package default grace (5 s) would have kept disconnect() waiting much longer.
    expect(Date.now() - disconnectAt).toBeLessThan(2_000);
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
  });

  // A stop is one in-flight operation: whoever asks for the disconnect while it
  // is pending waits for the child's end, not only the call that started it.
  it('makes a second disconnect() wait for the pending stop instead of resolving at once', async () => {
    const observed = observedTransport('stubborn-child', IGNORE_SIGTERM_SCRIPT, { stopTiming: { killGraceMs: 400 } });
    transport = observed.transport;

    await transport.connect();
    await transport.ready;
    const pid = await observed.reportedPid;
    strayPids.add(pid);
    const order: string[] = [];

    const first = transport.disconnect().then(() => order.push('first'));
    const second = transport.disconnect().then(() => order.push('second'));
    await second;

    // SIGTERM is ignored, so the child lives until the escalation at 400 ms.
    expect(isAlive(pid)).toBe(false);
    await first;
    expect(order).toEqual(expect.arrayContaining(['first', 'second']));
  });

  it('makes a disconnect() without a current session wait for a stop that is still pending', async () => {
    const observed = observedTransport('stubborn-child', IGNORE_SIGTERM_SCRIPT, { stopTiming: { killGraceMs: 400 } });
    transport = observed.transport;

    await transport.connect();
    await transport.ready;
    const pid = await observed.reportedPid;
    strayPids.add(pid);

    const first = transport.disconnect();
    await transport.disconnect();
    expect(isAlive(pid)).toBe(false);
    await first;

    // Once every stop has ended there is nothing left to wait for.
    await expect(transport.disconnect()).resolves.toBeUndefined();
  });

  // A session starts only after the previous one has ended, so a reconnect never
  // runs a second child beside one that is still being stopped.
  it('makes connect() wait for a pending stop and spawn the next child only once the old one is gone', async () => {
    const observed = observedTransport('stubborn-child', IGNORE_SIGTERM_SCRIPT, { stopTiming: { killGraceMs: 400 } });
    transport = observed.transport;

    await transport.connect();
    await transport.ready;
    const first = await observed.reportedPid;
    strayPids.add(first);

    const stopping = transport.disconnect();
    // SIGTERM is ignored, so the old child lives until the escalation at 400 ms.
    expect(isAlive(first)).toBe(true);
    await transport.connect();

    expect(isAlive(first)).toBe(false);
    await transport.ready;
    const pids = observed.received.flatMap((message) =>
      'subject' in message && message.subject === 'test.pid' ? [(message.payload as { pid: number }).pid] : [],
    );
    expect(pids).toHaveLength(2);
    expect(pids[1]).not.toBe(first);
    strayPids.add(pids[1]!);
    await stopping;
  });

  it('cancels a connect() that waits for a pending stop when disconnect() arrives, spawning nothing', async () => {
    const observed = observedTransport('stubborn-child', IGNORE_SIGTERM_SCRIPT, { stopTiming: { killGraceMs: 400 } });
    transport = observed.transport;

    await transport.connect();
    await transport.ready;
    const first = await observed.reportedPid;
    strayPids.add(first);

    const stopping = transport.disconnect();
    const reconnecting = transport.connect();
    const disconnecting = transport.disconnect();

    await expect(reconnecting).rejects.toThrow('connect() cancelled by disconnect()');
    await disconnecting;
    await stopping;
    expect(isAlive(first)).toBe(false);
    expect(transport.isReady()).toBe(false);
    expect(observed.received.filter((message) => 'subject' in message && message.subject === 'test.pid')).toHaveLength(
      1,
    );
    await expect(transport.connect()).resolves.toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('logs a disconnect() that leaves a group member running', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const observed = observedTransport('launcher-child', STUBBORN_GRANDCHILD_SCRIPT, {
      stopTiming: { killGraceMs: 200, exitObservationMs: 300 },
    });
    transport = observed.transport;

    await transport.connect();
    await transport.ready;
    const grandchild = await observed.reportedPid;
    strayPids.add(grandchild);

    await transport.disconnect();

    // The child died on SIGTERM; the member that ignores it outlived the stop.
    expect(isAlive(grandchild)).toBe(true);
    expect(warnSpy.mock.calls.flat().join('\n')).toContain(
      'launcher-child may have left processes running (stopped on request: exited with signal SIGTERM; process group quiescence unproven (poll-timeout))',
    );
  });

  it('leaves the grandchild running when tree termination is opted out', async () => {
    const observed = observedTransport('direct-child-parent', GRANDCHILD_SCRIPT, { terminateTree: false });
    transport = observed.transport;

    await transport.connect();
    await transport.ready;
    const grandchild = await observed.reportedPid;
    strayPids.add(grandchild);

    await transport.disconnect();

    expect(isAlive(grandchild)).toBe(true);
  });
});
