import type { ChildProcess } from 'node:child_process';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createJsonlTransport } from '../jsonl-transport.js';
import { describeTransportEnd, type TransportEnd } from '../process-end.js';
import { WindowsTreeTerminationError } from '../process-tree.js';
import type { StopHost } from '../stop-escalation.js';
import type { IJsonlTransport, JsonlTransportOptions } from '../types.js';
import {
  CLOSE_STDIN_AND_STAY,
  CLOSE_STDOUT_AND_STAY,
  GRANDCHILD_AND_STAY,
  GRANDCHILD_HOLDS_STDERR,
  GRANDCHILD_HOLDS_STDOUT,
  GRANDCHILD_IGNORES_SIGTERM,
  IGNORE_SIGTERM_AND_STAY,
  LAST_MESSAGE_THEN_EXIT,
  READY_AND_STAY,
  denyingPort,
  isAlive,
  killQuietly,
} from './fixtures/jsonl-children.js';

const ON_WINDOWS = process.platform === 'win32';

/** Tree evidence of an owned group that ended without a stop; Windows has no group to prove it for. */
const QUIESCENT_GROUP: TransportEnd['tree'] = ON_WINDOWS
  ? { kind: 'unproven', reason: 'no-termination' }
  : { kind: 'quiescent' };

/**
 * Every child the transport spawned in this file, in spawn order. The real
 * `spawn` still runs; the record only lets tests that check released pipes or
 * must force an event reach the real child, which the transport keeps to itself.
 */
const spawned = vi.hoisted(() => [] as ChildProcess[]);

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((...args: Parameters<typeof actual.spawn>) => {
      const child = actual.spawn(...args);
      spawned.push(child);
      return child;
    }),
  };
});

/**
 * The real child behind the transport spawned last.
 * @returns The most recently spawned child.
 */
function lastSpawnedChild(): ChildProcess {
  const child = spawned.at(-1);
  if (child === undefined) throw new Error('no child was spawned');
  return child;
}

/** Transports and stray descendants a test created; cleaned up after each test. */
const openTransports = new Set<IJsonlTransport>();
const strayPids = new Set<number>();

/**
 * Spawn a `node -e` child behind a transport that the suite cleans up.
 * @param script - Script source for `node -e`.
 * @param options - Transport options overriding the defaults of this suite.
 * @returns The transport.
 */
function spawnScript(script: string, options: Partial<JsonlTransportOptions> = {}): IJsonlTransport {
  const transport = createJsonlTransport({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    onStdoutEnd: 'terminal',
    ...options,
  });
  openTransports.add(transport);
  return transport;
}

/**
 * Wait for the first message of a transport.
 * @param transport - Transport to listen on.
 * @returns The first parsed message.
 */
function firstMessage(transport: IJsonlTransport): Promise<unknown> {
  return new Promise((resolve) => {
    const unsubscribe = transport.onMessage((message) => {
      unsubscribe();
      resolve(message);
    });
  });
}

/**
 * Read the grandchild PID a fixture reports first, and register it for cleanup.
 * @param transport - Transport of a fixture that reports a grandchild.
 * @returns The grandchild's PID.
 */
async function grandchildPid(transport: IJsonlTransport): Promise<number> {
  const message = (await firstMessage(transport)) as { grandchild: number };
  strayPids.add(message.grandchild);
  return message.grandchild;
}

/**
 * Report whether a promise is still pending after the current macrotask.
 * @param promise - Promise to probe.
 * @returns `true` while the promise has not settled.
 */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol('pending');
  const winner = await Promise.race([promise, new Promise((resolve) => setImmediate(() => resolve(pending)))]);
  return winner === pending;
}

describe('createJsonlTransport', () => {
  afterEach(async () => {
    await Promise.all([...openTransports].map((transport) => transport.close({ deadline: Date.now() + 2_000 })));
    openTransports.clear();
    for (const pid of strayPids) killQuietly(pid);
    strayPids.clear();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('messages', () => {
    it('should spawn a process and parse JSONL from stdout', async () => {
      const transport = spawnScript('process.stdout.write(JSON.stringify({ hello: "world" }) + "\\n")', {
        processName: 'test-echo',
      });

      await expect(firstMessage(transport)).resolves.toEqual({ hello: 'world' });
    });

    it('should support multiple message listeners', async () => {
      const transport = spawnScript('process.stdout.write(JSON.stringify({ a: 1 }) + "\\n")');

      const results: unknown[] = [];
      const done = Promise.all([
        new Promise<void>((resolve) => {
          transport.onMessage((msg) => {
            results.push(msg);
            resolve();
          });
        }),
        new Promise<void>((resolve) => {
          transport.onMessage((msg) => {
            results.push(msg);
            resolve();
          });
        }),
      ]);

      await done;
      expect(results).toEqual([{ a: 1 }, { a: 1 }]);
    });

    it('should return unsubscribe functions', async () => {
      const transport = spawnScript(
        'process.stdout.write(\'{"a":1}\\n\'); setTimeout(() => process.stdout.write(\'{"b":2}\\n\'), 100);',
      );

      const first: unknown[] = [];
      const second: unknown[] = [];
      const unsub = transport.onMessage((msg) => {
        first.push(msg);
        unsub();
      });
      transport.onMessage((msg) => second.push(msg));

      await transport.ended;

      expect(first).toEqual([{ a: 1 }]);
      expect(second).toEqual([{ a: 1 }, { b: 2 }]);
    });

    it('should handle multi-line JSONL output', async () => {
      const transport = spawnScript('process.stdout.write(\'{"x":1}\\n{"x":2}\\n{"x":3}\\n\')');
      const messages: unknown[] = [];
      transport.onMessage((msg) => messages.push(msg));

      await transport.ended;

      expect(messages).toEqual([{ x: 1 }, { x: 2 }, { x: 3 }]);
    });

    it('isolates a throwing message listener from later listeners', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const transport = spawnScript(
        'process.stdout.write(JSON.stringify({ a: 1 }) + "\\n"); setInterval(() => {}, 1000)',
        {
          processName: 'test-throwing-listener',
        },
      );

      transport.onMessage(() => {
        throw new Error('listener failed');
      });
      await expect(firstMessage(transport)).resolves.toEqual({ a: 1 });

      expect(transport.status).toBe('writable');
      expect(errorSpy).toHaveBeenCalledWith('[test-throwing-listener] transport listener threw', expect.any(Error));
    });

    it('fails the channel on a throwing listener under the fail policy', async () => {
      const transport = spawnScript(READY_AND_STAY, { listenerErrors: 'fail', killGraceMs: 1_000 });
      transport.onMessage(() => {
        throw new TypeError('consumer bug');
      });

      const end = await transport.ended;

      expect(end.cause).toBe('unexpected');
      expect(end.communicationFailure).toEqual({ kind: 'listener-failed', error: expect.any(TypeError) });
      expect(end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGTERM' });
    });

    it('drops invalid JSON lines without ending the transport or logging the line', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const transport = spawnScript(
        'process.stdout.write("not-json token=secret-value\\n" + JSON.stringify({ after: true }) + "\\n"); setInterval(() => {}, 1000)',
        { processName: 'test-bad-json' },
      );

      await expect(firstMessage(transport)).resolves.toEqual({ after: true });
      expect(transport.status).toBe('writable');
      expect(warnSpy).toHaveBeenCalledWith('[test-bad-json] dropped 1 malformed JSONL line(s) from stdout');
      expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('secret-value');
    });

    it('delivers a multibyte message written in two delayed writes split inside a character', async () => {
      const transport = spawnScript(`
const bytes = Buffer.from(JSON.stringify({ text: 'Grüße 💡 €' }) + '\\n', 'utf8');
const cut = bytes.indexOf(0xf0) + 2;
process.stdout.write(bytes.subarray(0, cut));
setTimeout(() => process.stdout.write(bytes.subarray(cut)), 100);
`);

      await expect(firstMessage(transport)).resolves.toEqual({ text: 'Grüße 💡 €' });
    });

    it('counts an unterminated final line at the stdout end, before reporting the end', async () => {
      const order: string[] = [];
      vi.spyOn(console, 'warn').mockImplementation((line: unknown) => order.push(String(line)));
      const transport = spawnScript('process.stdout.write(\'{"a":1}\\n{"token":"secret-value"}\')', {
        processName: 'test-final-line',
      });
      const messages: unknown[] = [];
      transport.onMessage((msg) => messages.push(msg));

      const end = await transport.ended;
      order.push(describeTransportEnd(end));

      expect(messages).toEqual([{ a: 1 }]);
      expect(end.drain).toEqual({ kind: 'complete', discardedChars: 24 });
      expect(order).toEqual([
        '[test-final-line] dropped an unterminated final line (24 chars) from stdout',
        'ended unexpectedly: exited with code 0; unterminated final stdout line discarded (24 chars)',
      ]);
    });

    it('parses an unterminated final line at the genuine stdout end under the parse policy', async () => {
      const transport = spawnScript('process.stdout.write(\'{"a":1}\\n{"b":2}\')', { finalLine: 'parse' });
      const messages: unknown[] = [];
      transport.onMessage((msg) => messages.push(msg));

      const end = await transport.ended;

      expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
      expect(end.drain).toEqual({ kind: 'complete', discardedChars: 0 });
    });
  });

  describe('spawn options', () => {
    it('should preserve parent environment variables when child env is provided', async () => {
      vi.stubEnv('MAKAIO_JSONL_PARENT_MARKER', 'from-parent');
      const transport = spawnScript(
        `
process.stdout.write(JSON.stringify({
  parent: process.env.MAKAIO_JSONL_PARENT_MARKER,
  child: process.env.MAKAIO_JSONL_CHILD_MARKER,
  removed: Object.prototype.hasOwnProperty.call(process.env, 'MAKAIO_JSONL_REMOVED_MARKER')
}) + '\\n');
`,
        { env: { MAKAIO_JSONL_CHILD_MARKER: 'from-child', MAKAIO_JSONL_REMOVED_MARKER: undefined } },
      );

      await expect(firstMessage(transport)).resolves.toEqual({
        parent: 'from-parent',
        child: 'from-child',
        removed: false,
      });
    });

    it('passes only the given environment under the replace mode', async () => {
      vi.stubEnv('MAKAIO_JSONL_PARENT_MARKER', 'from-parent');
      const transport = spawnScript(
        `process.stdout.write(JSON.stringify({ keys: Object.keys(process.env).filter((k) => k.startsWith('MAKAIO_JSONL')) }) + '\\n');`,
        { env: { MAKAIO_JSONL_CHILD_MARKER: 'from-child' }, envMode: 'replace' },
      );

      await expect(firstMessage(transport)).resolves.toEqual({ keys: ['MAKAIO_JSONL_CHILD_MARKER'] });
    });

    it('suppresses stderr content and says so once under the suppress mode', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const transport = spawnScript(
        `process.stderr.write('token=secret-value\\n', () => process.stderr.write('token=secret-value\\n'));`,
        { processName: 'test-stderr', stderr: 'suppress' },
      );

      await transport.ended;

      expect(warnSpy.mock.calls).toEqual([['[test-stderr] stderr output suppressed']]);
    });

    it.skipIf(ON_WINDOWS)('spawns the child as the leader of its own process group by default', async () => {
      const transport = spawnScript(READY_AND_STAY);
      const child = lastSpawnedChild();
      await firstMessage(transport);
      const pid = child.pid!;

      // A group named after the child exists only when the child leads it.
      expect(() => process.kill(-pid, 0)).not.toThrow();
    });
  });

  describe('end report', () => {
    it('reports a process that could not be spawned exactly once, as spawn-failed', async () => {
      const transport = spawnScript('', { command: '/definitely/missing/jsonl-binary', processName: 'test-missing' });

      const end = await transport.ended;

      expect(end.cause).toBe('spawn-failed');
      expect(end.exit).toEqual({ kind: 'spawn-failed', error: expect.objectContaining({ code: 'ENOENT' }) });
      expect(end.tree).toEqual({ kind: 'quiescent' });
      // A child that never started has nothing to drain, on every runtime.
      expect(end.drain).toEqual({ kind: 'complete', discardedChars: 0 });
      await expect(transport.exitObserved).resolves.toEqual(end.exit);
      expect(describeTransportEnd(end)).toBe('failed to start: could not be spawned (ENOENT)');
      expect(transport.status).toBe('ended');
      expect(() => transport.send({ late: true })).toThrow('not writable');
    });

    it('reports close() before a failed spawn as requested', async () => {
      const transport = spawnScript('', { command: '/definitely/missing/jsonl-binary' });

      const end = await transport.close();

      expect(end.cause).toBe('requested');
      expect(end.exit.kind).toBe('spawn-failed');
    });

    it('delivers a message written just before the exit before the end report', async () => {
      const transport = spawnScript(LAST_MESSAGE_THEN_EXIT);
      const messages: unknown[] = [];
      transport.onMessage((msg) => messages.push(msg));

      const deliveredAtEnd = await transport.ended.then((end) => ({ end, delivered: [...messages] }));

      expect(deliveredAtEnd.delivered).toEqual([{ last: true }]);
      expect(deliveredAtEnd.end).toEqual({
        cause: 'unexpected',
        exit: { kind: 'exited', code: 0, signal: null },
        drain: { kind: 'complete', discardedChars: 0 },
        communicationFailure: undefined,
        // The group is probed after every end, also one nobody requested.
        tree: QUIESCENT_GROUP,
      } satisfies TransportEnd);
    });

    it.each([
      ['a non-zero exit', 'process.exit(1)', 'ended unexpectedly: exited with code 1'],
      ['a clean exit', 'process.exit(0)', 'ended unexpectedly: exited with code 0'],
      [
        'a signal it did not get from close()',
        'process.kill(process.pid, "SIGKILL")',
        'ended unexpectedly: exited with signal SIGKILL',
      ],
    ])('reports %s that the transport did not request as unexpected', async (_case, script, description) => {
      const transport = spawnScript(script, { processName: 'test-exit' });

      const end = await transport.ended;

      expect(end.cause).toBe('unexpected');
      expect(describeTransportEnd(end)).toBe(description);
    });

    it('keeps the unexpected cause when close() runs while the end is delivered', async () => {
      const transport = spawnScript('process.exit(1)');
      let closedDuringDelivery: Promise<TransportEnd> | undefined;
      void transport.ended.then(() => {
        closedDuringDelivery = transport.close();
      });

      const end = await transport.ended;

      expect(end.cause).toBe('unexpected');
      expect(closedDuringDelivery).toBeDefined();
      await expect(closedDuringDelivery).resolves.toBe(end);
    });

    it('drains a stdout held by a grandchild until the deadline and reports the exit separately', async () => {
      const transport = spawnScript(GRANDCHILD_HOLDS_STDOUT, { drainTimeoutMs: 300 });
      const child = lastSpawnedChild();
      const pid = await grandchildPid(transport);

      const exit = await transport.exitObserved;
      const exitAt = Date.now();
      const end = await transport.ended;

      expect(exit).toEqual({ kind: 'exited', code: 0, signal: null });
      expect(Date.now() - exitAt).toBeGreaterThanOrEqual(250);
      expect(end.cause).toBe('unexpected');
      expect(end.exit).toEqual(exit);
      expect(end.drain).toEqual({ kind: 'timed-out', discardedChars: 'partial'.length, stdoutComplete: false });
      expect(child.stdout?.destroyed).toBe(true);
      expect(child.stderr?.destroyed).toBe(true);
      // The exit was observed before any stop, so the grandchild was never
      // signalled; the probe of the group finds it alive.
      expect(isAlive(pid)).toBe(true);
      if (!ON_WINDOWS) expect(end.tree).toEqual({ kind: 'unproven', reason: 'poll-timeout' });
    });

    it('reports an exit observed before close() as unexpected, and close() shortens the drain', async () => {
      const transport = spawnScript(GRANDCHILD_HOLDS_STDOUT, { drainTimeoutMs: 20_000 });
      await grandchildPid(transport);
      await transport.exitObserved;

      const closedAt = Date.now();
      const end = await transport.close({ deadline: closedAt + 200 });

      expect(Date.now() - closedAt).toBeLessThan(2_000);
      expect(end.cause).toBe('unexpected');
      expect(end.drain.kind).toBe('timed-out');
    });

    it('reports a stderr held past the drain deadline as timed out, with stdout complete', async () => {
      const transport = spawnScript(GRANDCHILD_HOLDS_STDERR, { drainTimeoutMs: 300 });
      const child = lastSpawnedChild();
      await grandchildPid(transport);

      await transport.exitObserved;
      const exitAt = Date.now();
      const end = await transport.ended;

      expect(Date.now() - exitAt).toBeGreaterThanOrEqual(250);
      expect(end.exit).toEqual({ kind: 'exited', code: 0, signal: null });
      expect(end.drain).toEqual({ kind: 'timed-out', discardedChars: 0, stdoutComplete: true });
      expect(child.stderr?.destroyed).toBe(true);
    });

    it('ends a terminal channel whose stdout ended without an exit, and stops the child', async () => {
      const transport = spawnScript(CLOSE_STDOUT_AND_STAY, { onStdoutEnd: 'terminal', drainTimeoutMs: 300 });

      const end = await transport.ended;

      expect(end.cause).toBe('unexpected');
      expect(end.communicationFailure).toEqual({ kind: 'stdout-ended' });
      expect(end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGTERM' });
      expect(end.drain).toEqual({ kind: 'complete', discardedChars: 0 });
    });

    it('keeps supervising a child whose stdout ended under the ignore policy', async () => {
      const transport = spawnScript(CLOSE_STDOUT_AND_STAY, { onStdoutEnd: 'ignore', drainTimeoutMs: 200 });
      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(await isPending(transport.ended)).toBe(true);
      expect(transport.status).toBe('writable');

      const end = await transport.close();
      expect(end.cause).toBe('requested');
      expect(end.communicationFailure).toBeUndefined();
      expect(end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGTERM' });
    });

    it('fails the channel when the child closes stdin and keeps running', async () => {
      const transport = spawnScript(CLOSE_STDIN_AND_STAY, { killGraceMs: 1_000 });
      await firstMessage(transport);

      transport.send({ ping: true });
      const end = await transport.ended;

      expect(end.cause).toBe('unexpected');
      expect(end.communicationFailure).toEqual({
        kind: 'stdin-failed',
        error: expect.objectContaining({ code: 'EPIPE' }),
      });
      expect(end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGTERM' });
      expect(() => transport.send({ ping: true })).toThrow('not writable');
    });

    it('fails the channel on a stdout error and drops the undelivered rest', async () => {
      const transport = spawnScript(
        `process.stdout.write('{"ready":true}\\n{"partial"'); setInterval(() => {}, 1000);`,
        {
          killGraceMs: 1_000,
        },
      );
      const child = lastSpawnedChild();
      await firstMessage(transport);

      // A real pipe read error cannot be provoked from the child; the event is
      // forced on the real stream to reach this ordering.
      child.stdout?.emit('error', Object.assign(new Error('read failed'), { code: 'ECONNRESET' }));
      expect(transport.status).toBe('ending');
      const end = await transport.ended;

      expect(end.cause).toBe('unexpected');
      expect(end.communicationFailure).toEqual({
        kind: 'stdout-failed',
        error: expect.objectContaining({ code: 'ECONNRESET' }),
      });
      expect(end.drain).toEqual({ kind: 'failed', discardedChars: '{"partial"'.length });
      expect(end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGTERM' });
    });

    it('logs a child process error after the spawn without ending the transport', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const transport = spawnScript(READY_AND_STAY, { processName: 'test-late-error' });
      const child = lastSpawnedChild();
      await firstMessage(transport);

      // Node reports an error after the spawn only for its own kill() and IPC,
      // which this transport never uses; the event is forced to pin that it is
      // a diagnostic, not an end.
      child.emit('error', Object.assign(new Error('secret-value'), { code: 'EINVAL' }));

      expect(transport.status).toBe('writable');
      expect(await isPending(transport.ended)).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        '[test-late-error] child process reported an error after the spawn (EINVAL)',
      );
      expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('secret-value');
    });
  });

  describe('close()', () => {
    it('blocks writes at once and returns the same end report from every call', async () => {
      const transport = spawnScript(READY_AND_STAY);
      await firstMessage(transport);

      const first = transport.close();
      expect(transport.status).toBe('ending');
      expect(() => transport.send({ late: true })).toThrow('not writable');
      const second = transport.close();

      const end = await first;
      expect(await second).toBe(end);
      expect(await transport.ended).toBe(end);
      expect(await transport.close()).toBe(end);
      expect(transport.status).toBe('ended');
      expect(end).toMatchObject({ cause: 'requested', exit: { kind: 'exited', code: null, signal: 'SIGTERM' } });
    });

    it('escalates to SIGKILL when the child ignores SIGTERM', async () => {
      const transport = spawnScript(IGNORE_SIGTERM_AND_STAY, { killGraceMs: 200 });
      await firstMessage(transport);

      const end = await transport.close();

      expect(end.cause).toBe('requested');
      expect(end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGKILL' });
    });

    it.skipIf(ON_WINDOWS)('stops the grandchild together with the child, and proves the group quiescent', async () => {
      const transport = spawnScript(GRANDCHILD_AND_STAY);
      const pid = await grandchildPid(transport);

      const end = await transport.close();

      expect(end.tree).toEqual({ kind: 'quiescent' });
      await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
    });

    // Windows has no process groups: the stop ends the tree with `taskkill /T /F`
    // in one stage, and the end report counts a successful one as the proof.
    it.runIf(ON_WINDOWS)('ends the grandchild with the child through the process tree on Windows', async () => {
      const transport = spawnScript(GRANDCHILD_AND_STAY);
      const pid = await grandchildPid(transport);

      const end = await transport.close();

      expect(end.cause).toBe('requested');
      expect(end.exit.kind).toBe('exited');
      expect(end.tree).toEqual({ kind: 'quiescent' });
      await vi.waitFor(() => expect(isAlive(pid)).toBe(false));
    });

    // Pins the signalling rule of `process-tree.ts`: a group is signalled only
    // until the owner observed its leader's exit, so a member that survives
    // SIGTERM after the leader died is reported, not killed. Changing that rule
    // flips this case.
    it.skipIf(ON_WINDOWS)(
      'reports a group member that outlives the child as unproven, apart from the child exit',
      async () => {
        const transport = spawnScript(GRANDCHILD_IGNORES_SIGTERM, { killGraceMs: 200, exitObservationMs: 300 });
        const pid = await grandchildPid(transport);

        const end = await transport.close();

        // The child died on SIGTERM; the stop ended with its observed exit, so
        // the grandchild that ignored SIGTERM never got SIGKILL.
        expect(end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGTERM' });
        expect(end.tree).toEqual({ kind: 'unproven', reason: 'poll-timeout' });
        expect(isAlive(pid)).toBe(true);
      },
    );

    it.skipIf(ON_WINDOWS)('lets a tighter deadline end a pending quiescence proof', async () => {
      const transport = spawnScript(GRANDCHILD_IGNORES_SIGTERM, { exitObservationMs: 10_000, drainTimeoutMs: 10_000 });
      await grandchildPid(transport);

      void transport.close();
      await transport.exitObserved;
      const tightenedAt = Date.now();
      const end = await transport.close({ deadline: tightenedAt + 100 });

      expect(Date.now() - tightenedAt).toBeLessThan(1_500);
      expect(end.tree).toEqual({ kind: 'unproven', reason: 'poll-timeout' });
    });

    it('leaves the grandchild alone when the tree is not owned', async () => {
      const transport = spawnScript(GRANDCHILD_AND_STAY, { terminateTree: false });
      const pid = await grandchildPid(transport);

      const end = await transport.close();

      expect(end.tree).toEqual({ kind: 'not-owned' });
      expect(isAlive(pid)).toBe(true);
    });

    // On Windows the tree stop runs taskkill, which does not go through the injected port.
    it.skipIf(ON_WINDOWS)(
      'ends as unobserved when the stop signals are denied, and still observes a later exit',
      async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const transport = spawnScript(READY_AND_STAY, {
          signalPort: denyingPort(),
          killGraceMs: 50,
          exitObservationMs: 100,
        });
        const child = lastSpawnedChild();
        await firstMessage(transport);
        const pid = child.pid!;

        const end = await transport.close();

        expect(end.cause).toBe('requested');
        expect(end.exit).toEqual({ kind: 'unobserved', reason: 'signal-denied' });
        // No drain window opened: the pipes were released at once.
        expect(end.drain).toEqual({ kind: 'abandoned', discardedChars: 0 });
        expect(transport.status).toBe('ended');
        expect(child.stdout?.destroyed).toBe(true);
        expect(await isPending(transport.exitObserved)).toBe(true);
        const warningsAtEnd = warnSpy.mock.calls.length;

        process.kill(pid, 'SIGKILL');
        await expect(transport.exitObserved).resolves.toEqual({ kind: 'exited', code: null, signal: 'SIGKILL' });
        // The late exit is a separate observation: the reported end stays the one already delivered.
        expect(transport.status).toBe('ended');
        expect(await transport.ended).toBe(end);
        expect(await transport.close()).toBe(end);
        expect(warnSpy.mock.calls).toHaveLength(warningsAtEnd);
      },
    );

    it.skipIf(ON_WINDOWS)('ends as unobserved when the signals are delivered but no exit follows in time', async () => {
      const transport = spawnScript(READY_AND_STAY, {
        signalPort: { kill: () => {} },
        killGraceMs: 50,
        exitObservationMs: 100,
      });
      const child = lastSpawnedChild();
      await firstMessage(transport);
      const pid = child.pid!;

      const end = await transport.close();

      expect(end.exit).toEqual({ kind: 'unobserved', reason: 'observation-timeout' });
      expect(end.drain).toEqual({ kind: 'abandoned', discardedChars: 0 });
      process.kill(pid, 'SIGKILL');
      await expect(transport.exitObserved).resolves.toEqual({ kind: 'exited', code: null, signal: 'SIGKILL' });
    });

    it('honours a deadline shorter than the kill grace', async () => {
      const transport = spawnScript(IGNORE_SIGTERM_AND_STAY, { killGraceMs: 20_000, exitObservationMs: 100 });
      await firstMessage(transport);

      const closedAt = Date.now();
      const end = await transport.close({ deadline: closedAt + 500 });

      expect(Date.now() - closedAt).toBeLessThan(2_000);
      expect(end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGKILL' });
    });
  });

  // The Windows tree stop is driven against a real child on a POSIX host through
  // the internal `stopHost` seam: the simulated `taskkill` is the only thing that
  // terminates the tree, so the order of the stop and the end report is the real one.
  describe.skipIf(ON_WINDOWS)('Windows tree stop (simulated host)', () => {
    /**
     * Build a simulated Windows host whose `taskkill` is the given function.
     * @param terminate - Stand-in for the forceful tree termination.
     * @returns The host facts for the `stopHost` option.
     */
    function windowsHost(terminate: StopHost['terminateWindowsTree']): StopHost {
      return { platform: 'win32', terminateWindowsTree: terminate };
    }

    it('reports the end only after taskkill has finished, also when the child exited meanwhile', async () => {
      const taskkill = Promise.withResolvers<'delivered'>();
      const terminated: number[] = [];
      const transport = spawnScript(READY_AND_STAY, {
        stopHost: windowsHost((pid) => {
          terminated.push(pid);
          return taskkill.promise;
        }),
      });
      const child = lastSpawnedChild();
      await firstMessage(transport);

      const ending = transport.close();
      // One forceful stage through taskkill; no POSIX signal went to the child.
      expect(terminated).toEqual([child.pid]);
      expect(child.signalCode).toBeNull();

      // The child exits by itself while taskkill is still ending its tree.
      process.kill(child.pid!, 'SIGKILL');
      await expect(transport.exitObserved).resolves.toEqual({ kind: 'exited', code: null, signal: 'SIGKILL' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await isPending(ending)).toBe(true);

      taskkill.resolve('delivered');
      const end = await ending;
      expect(end.cause).toBe('requested');
      expect(end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGKILL' });
      expect(end.tree).toEqual({ kind: 'quiescent' });
    });

    it('reports a refused termination as unproven (signal-error)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const transport = spawnScript(READY_AND_STAY, {
        stopHost: windowsHost(() => Promise.reject(new Error('Access is denied'))),
        exitObservationMs: 100,
      });
      const child = lastSpawnedChild();
      await firstMessage(transport);

      try {
        const end = await transport.close();

        // Nothing ended the tree, so the child's exit stays unobserved.
        expect(end.exit).toEqual({ kind: 'unobserved', reason: 'signal-denied' });
        expect(end.tree).toEqual({ kind: 'unproven', reason: 'signal-error' });
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('stop signal failed'));
      } finally {
        killQuietly(child.pid!);
      }
    });

    it('reports a termination that did not finish in its bound as unproven (poll-timeout)', async () => {
      const transport = spawnScript(READY_AND_STAY, {
        stopHost: windowsHost(() =>
          Promise.reject(new WindowsTreeTerminationError('timed-out', 'timeout', 1, new Error('timed out'))),
        ),
        exitObservationMs: 100,
      });
      const child = lastSpawnedChild();
      await firstMessage(transport);

      try {
        const end = await transport.close();

        expect(end.exit).toEqual({ kind: 'unobserved', reason: 'observation-timeout' });
        expect(end.tree).toEqual({ kind: 'unproven', reason: 'poll-timeout' });
      } finally {
        killQuietly(child.pid!);
      }
    });

    it('ends at the caller deadline while taskkill is still running, with the tree unproven (poll-timeout)', async () => {
      const transport = spawnScript(READY_AND_STAY, {
        stopHost: windowsHost(() => new Promise(() => {})),
        exitObservationMs: 5_000,
      });
      const child = lastSpawnedChild();
      await firstMessage(transport);

      try {
        const closedAt = Date.now();
        const end = await transport.close({ deadline: closedAt + 300 });

        expect(Date.now() - closedAt).toBeLessThan(3_000);
        expect(end.exit).toEqual({ kind: 'unobserved', reason: 'observation-timeout' });
        expect(end.tree).toEqual({ kind: 'unproven', reason: 'poll-timeout' });
      } finally {
        killQuietly(child.pid!);
      }
    });
  });
});
