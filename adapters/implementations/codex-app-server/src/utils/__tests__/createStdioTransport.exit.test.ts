/**
 * The Codex transport on the shared JSONL transport, one real app-server child
 * per phase of its end.
 *
 * The end report is the one fact the connector evaluates, so every case asserts
 * it from a real child: its cause (derived from the order of what the transport
 * observed, never from a marker), the exit with code and signal kept apart, and
 * the drain, together with the content-free description built from them. A stub
 * cannot show any of this — a real signal, a real child and a real pipe have to
 * interleave — so every case spawns a real process.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONNECTOR_EXIT_OBSERVATION_MS } from '@makaio/ai-adapters-core';
import { describeTransportEnd, type IJsonlTransport } from '@makaio/subprocess';

import { APP_SERVER_STOP_TIMING } from '../createStdioTransport.js';
import { createStdioTransport } from '../createStdioTransport.js';
import { createJsonRpcClient } from '../jsonRpcClient.js';

/** Child source: answers the first request, then exits cleanly once the answer reached the pipe. */
const ANSWER_THEN_EXIT_0 = `
process.stdin.once('data', (chunk) => {
  const { id } = JSON.parse(String(chunk).split('\\n')[0]);
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }) + '\\n', () => process.exit(0));
});
`;

/** Child source: announces itself and stays alive. */
const ANNOUNCE_AND_STAY = `
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'ready' }) + '\\n');
setInterval(() => {}, 1000);
`;

/** Child source: ignores SIGTERM, announces itself and stays alive. */
const IGNORE_SIGTERM_AND_STAY = `
process.on('SIGTERM', () => {});
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'ready' }) + '\\n');
setInterval(() => {}, 1000);
`;

/**
 * Child source: leaves a grandchild holding stdout, reports it and exits cleanly,
 * so stdout never reaches its end while the grandchild lives.
 */
const GRANDCHILD_HOLDS_STDOUT = `
const grandchild = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
  stdio: ['ignore', 'inherit', 'ignore'],
});
grandchild.unref();
process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'grandchild', params: { pid: grandchild.pid } }) + '\\n', () =>
  process.exit(0),
);
`;

/** Working directories {@link appServerCwd} created; removed after each test. */
const appServerDirs: string[] = [];

/**
 * Create a working directory holding an `app-server` script.
 *
 * The transport always spawns `<binary> app-server`, so the child's behaviour is
 * chosen by writing the script that name resolves to, and the real spawn path is
 * exercised unchanged.
 * @param source - Node source for the `app-server` script.
 * @returns Directory to pass as the transport's cwd.
 */
function appServerCwd(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-appserver-'));
  appServerDirs.push(dir);
  const script = join(dir, 'app-server');
  writeFileSync(script, source, 'utf8');
  chmodSync(script, 0o755);
  return dir;
}

const transports: IJsonlTransport[] = [];

/**
 * Start a real app-server child running `source`, with the connector's stop timing.
 * @param source - Node source for the `app-server` script.
 * @param env - The child's complete environment.
 * @returns The transport to the child.
 */
function startAppServer(source: string, env: Record<string, string> = {}): IJsonlTransport {
  const transport = createStdioTransport({
    cwd: appServerCwd(source),
    env,
    binaryPath: process.execPath,
    timing: APP_SERVER_STOP_TIMING,
  });
  transports.push(transport);
  return transport;
}

/**
 * Resolve with the first message the transport delivers.
 * @param transport - Transport to observe.
 * @returns The first delivered message.
 */
function firstMessage(transport: IJsonlTransport): Promise<unknown> {
  return new Promise((resolve) => {
    const unsubscribe = transport.onMessage((message) => {
      unsubscribe();
      resolve(message);
    });
  });
}

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  for (const dir of appServerDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('Codex transport stop timing', () => {
  it('fits a whole stop — kill grace, exit observation and drain — inside the connector budget', () => {
    const { killGraceMs, exitObservationMs, drainTimeoutMs } = APP_SERVER_STOP_TIMING;

    expect(killGraceMs + exitObservationMs + drainTimeoutMs).toBeLessThan(CONNECTOR_EXIT_OBSERVATION_MS);
  });

  it('escalates to SIGKILL and observes the exit inside the connector budget', async () => {
    const transport = startAppServer(IGNORE_SIGTERM_AND_STAY);
    await firstMessage(transport);

    const startedAt = Date.now();
    const end = await transport.close();

    expect(Date.now() - startedAt).toBeLessThan(CONNECTOR_EXIT_OBSERVATION_MS);
    expect(end).toMatchObject({ cause: 'requested', exit: { kind: 'exited', code: null, signal: 'SIGKILL' } });
    await expect(transport.exitObserved).resolves.toEqual({ kind: 'exited', code: null, signal: 'SIGKILL' });
  });
});

describe('Codex transport end', () => {
  it('reports a binary that never ran as exactly one spawn-failed end', async () => {
    const transport = createStdioTransport({
      cwd: process.cwd(),
      env: {},
      binaryPath: '/definitely/missing/codex-binary',
      timing: APP_SERVER_STOP_TIMING,
    });
    transports.push(transport);

    const end = await transport.ended;

    expect(end.cause).toBe('spawn-failed');
    expect((await transport.exitObserved).kind).toBe('spawn-failed');
    expect(describeTransportEnd(end)).toBe('failed to start: could not be spawned (ENOENT)');
  });

  it('delivers the last response, then reports exactly one unexpected end for a clean exit nobody asked for', async () => {
    const transport = startAppServer(ANSWER_THEN_EXIT_0);
    const client = createJsonRpcClient(transport);

    await expect(client.request('initialize', {})).resolves.toEqual({ ok: true });
    const end = await transport.ended;

    expect(end).toMatchObject({ cause: 'unexpected', exit: { kind: 'exited', code: 0, signal: null } });
    expect(describeTransportEnd(end)).toBe('ended unexpectedly: exited with code 0');
  });

  it('rejects an in-flight request when the child exits 0 after a malformed line', async () => {
    const transport = startAppServer(
      "process.stdin.once('data', () => { process.stdout.write('not json\\n', () => process.exit(0)); });\n",
    );
    const client = createJsonRpcClient(transport);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(client.request('initialize', {})).rejects.toThrow(
      'JSON-RPC transport ended unexpectedly: exited with code 0',
    );
    expect((await transport.ended).cause).toBe('unexpected');
  });

  it('reports a requested close as requested', async () => {
    const transport = startAppServer(ANNOUNCE_AND_STAY);
    await firstMessage(transport);

    const end = await transport.close();

    expect(end).toMatchObject({ cause: 'requested', exit: { kind: 'exited', code: null, signal: 'SIGTERM' } });
    expect(transport.status).toBe('ended');
  });

  it('keeps a death of its own cause after the stop intent requested, with its real exit code', async () => {
    // The child ignores the signal and then dies on its own, so the exit lands
    // *after* the stop intent for a cause the intent did not create. The cause
    // follows the order of the facts (the intent came first); the exit says what
    // really happened.
    const transport = startAppServer(
      [
        "process.on('SIGTERM', () => {});",
        "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'ready' }) + '\\n');",
        'setTimeout(() => process.exit(23), 250);',
        '',
      ].join('\n'),
    );
    await firstMessage(transport);

    const end = await transport.close();

    expect(end).toMatchObject({ cause: 'requested', exit: { kind: 'exited', code: 23, signal: null } });
  });

  it('ends after the drain deadline, inside the budget, when a grandchild inherits stdout', async () => {
    const transport = startAppServer(GRANDCHILD_HOLDS_STDOUT);
    const announced = firstMessage(transport) as Promise<{ params: { pid: number } }>;
    const grandchild = (await announced).params.pid;
    try {
      await transport.exitObserved;
      const exitedAt = Date.now();
      const end = await transport.ended;
      const endedAfter = Date.now() - exitedAt;

      expect(end).toMatchObject({
        cause: 'unexpected',
        exit: { kind: 'exited', code: 0, signal: null },
        drain: { kind: 'timed-out' },
      });
      // Timer granularity: a deadline may fire a millisecond early.
      expect(endedAfter).toBeGreaterThanOrEqual(APP_SERVER_STOP_TIMING.drainTimeoutMs - 5);
      expect(endedAfter).toBeLessThan(CONNECTOR_EXIT_OBSERVATION_MS);
    } finally {
      process.kill(grandchild, 'SIGKILL');
    }
  });

  it('treats a throwing message consumer as a transport failure and stops the child', async () => {
    const transport = startAppServer(ANNOUNCE_AND_STAY);
    transport.onMessage(() => {
      throw new Error('consumer saw secret-value');
    });

    const end = await transport.ended;

    expect(end).toMatchObject({
      cause: 'unexpected',
      exit: { kind: 'exited', signal: 'SIGTERM' },
      communicationFailure: { kind: 'listener-failed' },
    });
    expect(describeTransportEnd(end)).toBe(
      'ended unexpectedly: exited with signal SIGTERM; message listener failed (Error)',
    );
  });

  it('parses an unterminated final line at the genuine end of stdout and delivers it before the end', async () => {
    const transport = startAppServer(
      "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'last' }), () => process.exit(0));\n",
    );
    const order: string[] = [];
    transport.onMessage((message) => order.push(JSON.stringify(message)));

    const end = await transport.ended;
    order.push('ended');

    expect(order).toEqual(['{"jsonrpc":"2.0","method":"last"}', 'ended']);
    expect(end.drain).toEqual({ kind: 'complete', discardedChars: 0 });
  });
});

describe('Codex transport child environment and diagnostics', () => {
  it('gives the child the configured environment only, never the host environment', async () => {
    expect(process.env['HOME']).toBeDefined();
    const transport = startAppServer(
      [
        'const env = { home: process.env.HOME ?? null, marker: process.env.CODEX_TEST_MARKER ?? null };',
        "process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'env', params: env }) + '\\n');",
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
      { CODEX_TEST_MARKER: 'configured' },
    );

    await expect(firstMessage(transport)).resolves.toMatchObject({ params: { home: null, marker: 'configured' } });
  });

  it('suppresses stderr with a single content-free warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const transport = startAppServer(
      [
        "process.stderr.write('secret-bearing stderr output\\n');",
        'setTimeout(() => {',
        "  process.stderr.write('another secret-bearing chunk\\n');",
        "  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'ready' }) + '\\n');",
        '}, 50);',
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
    );
    await firstMessage(transport);

    // Every stderr chunk has been read once the pipes closed.
    await transport.close();

    const logged = warn.mock.calls.map((call) => call.join(' '));
    expect(logged.filter((line) => line === '[codex app-server] stderr output suppressed')).toHaveLength(1);
    expect(logged.join('\n')).not.toContain('secret-bearing');
  });
});

describe('Codex transport framing', () => {
  // Pipe chunks split wherever the child's writes land, so a character can arrive
  // in two chunks. Only a real child with two delayed writes produces that split.
  it('delivers a multibyte message written in two delayed writes split inside a character', async () => {
    const transport = startAppServer(
      [
        "const bytes = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'note', params: { text: 'Grüße 💡 €' } }) + '\\n', 'utf8');",
        'const cut = bytes.indexOf(0xf0) + 2;',
        'process.stdout.write(bytes.subarray(0, cut));',
        'setTimeout(() => process.stdout.write(bytes.subarray(cut)), 100);',
        'setInterval(() => {}, 1000);',
        '',
      ].join('\n'),
    );
    await expect(firstMessage(transport)).resolves.toEqual({
      jsonrpc: '2.0',
      method: 'note',
      params: { text: 'Grüße 💡 €' },
    });
    expect(transport.status).toBe('writable');
  });
});
