/// <reference types="bun-types" />
/**
 * The JSONL transport's end report under Bun.
 *
 * Bun runs hosts that supervise children through this transport, and its
 * child-process events do not arrive in Node's order in every case (a failed
 * spawn reports `close` without a stdout `end`), nor does it report every
 * failure Node reports (a write to a closed stdin succeeds). These cases pin the
 * end facts of the paths such a host exercises against real children, so a
 * runtime difference cannot turn into an invented fact such as a truncated
 * drain, and a known divergence stays visible.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createJsonlTransport } from '../jsonl-transport.js';
import { createProcessLifecycle } from '../process-lifecycle.js';
import type { ProcessLifecycleHandle, ProcessRunOutcome } from '../process-lifecycle.js';
import type { IJsonlTransport, JsonlTransportOptions } from '../types.js';
import {
  CLOSE_STDIN_AND_STAY,
  CLOSE_STDOUT_AND_STAY,
  GRANDCHILD_AND_STAY,
  GRANDCHILD_HOLDS_STDOUT,
  IGNORE_SIGTERM_AND_STAY,
  LAST_MESSAGE_THEN_EXIT,
  READY_AND_STAY,
  isAlive,
  killQuietly,
} from './fixtures/jsonl-children.js';

const ON_WINDOWS = process.platform === 'win32';

/** Transports, lifecycles and stray descendants a test created; cleaned up after each test. */
const openTransports = new Set<IJsonlTransport>();
const openLifecycles = new Set<ProcessLifecycleHandle>();
const strayPids = new Set<number>();

/**
 * Wait until a condition holds, polling every 20 ms.
 * @param condition - Predicate to poll.
 * @param timeoutMs - Longest wait before failing.
 * @returns Promise that resolves once the condition holds.
 */
async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs}ms`);
    await Bun.sleep(20);
  }
}

/**
 * Wait until the first message of a transport arrived.
 * @param transport - Transport of a fixture that writes a first message.
 * @returns The first message.
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
 * Spawn a child running `script` under the current runtime, behind a transport the suite cleans up.
 * @param script - Script source for `-e`.
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
 * Read the grandchild PID a fixture reports first, and register it for cleanup.
 * @param transport - Transport of a fixture that reports a grandchild.
 * @returns The grandchild's PID.
 */
function grandchildPid(transport: IJsonlTransport): Promise<number> {
  return new Promise((resolve) => {
    const unsubscribe = transport.onMessage((message) => {
      unsubscribe();
      const pid = (message as { grandchild: number }).grandchild;
      strayPids.add(pid);
      resolve(pid);
    });
  });
}

describe('createJsonlTransport under Bun', () => {
  afterEach(async () => {
    await Promise.all([...openTransports].map((transport) => transport.close({ deadline: Date.now() + 2_000 })));
    openTransports.clear();
    await Promise.all([...openLifecycles].map((handle) => handle.stop()));
    openLifecycles.clear();
    for (const pid of strayPids) killQuietly(pid);
    strayPids.clear();
  });

  it('reports a failed spawn with a complete drain', async () => {
    const transport = spawnScript('', { command: '/definitely/missing/jsonl-binary' });

    const end = await transport.ended;

    expect(end.cause).toBe('spawn-failed');
    expect(end.drain).toEqual({ kind: 'complete', discardedChars: 0 });
    expect(end.tree).toEqual({ kind: 'quiescent' });
  });

  it('delivers the last message before reporting a clean exit', async () => {
    const transport = spawnScript(LAST_MESSAGE_THEN_EXIT);
    const messages: unknown[] = [];
    transport.onMessage((message) => messages.push(message));

    const delivered = await transport.ended.then((end) => ({ end, messages: [...messages] }));

    expect(delivered.messages).toEqual([{ last: true }]);
    expect(delivered.end.cause).toBe('unexpected');
    expect(delivered.end.exit).toEqual({ kind: 'exited', code: 0, signal: null });
    expect(delivered.end.drain).toEqual({ kind: 'complete', discardedChars: 0 });
  });

  it.skipIf(ON_WINDOWS)('stops the process group on request and proves it quiescent', async () => {
    const transport = spawnScript(GRANDCHILD_AND_STAY);
    const pid = await grandchildPid(transport);

    const end = await transport.close();

    expect(end.cause).toBe('requested');
    expect(end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGTERM' });
    expect(end.tree).toEqual({ kind: 'quiescent' });
    // A quiescent group may still list the grandchild as an unreaped zombie.
    await waitUntil(() => !isAlive(pid));
  });

  it.skipIf(ON_WINDOWS)('escalates to SIGKILL for a child that ignores SIGTERM', async () => {
    const transport = spawnScript(IGNORE_SIGTERM_AND_STAY, { killGraceMs: 200 });
    await firstMessage(transport);

    const end = await transport.close();

    expect(end.cause).toBe('requested');
    expect(end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGKILL' });
  });

  it('keeps supervising a child that closed stdout under the ignore policy', async () => {
    const transport = spawnScript(CLOSE_STDOUT_AND_STAY, { onStdoutEnd: 'ignore', drainTimeoutMs: 200 });

    await Bun.sleep(600);
    expect(transport.status).toBe('writable');

    const end = await transport.close();
    expect(end.cause).toBe('requested');
    expect(end.communicationFailure).toBeUndefined();
  });

  // Divergence from a Node host, pinned so it stays visible: Bun reports a write
  // to a stdin whose reader closed as successful and emits no error, so the
  // channel does not fail as `stdin-failed` (see `CommunicationFailure`).
  it('does not detect a write to a child that closed its stdin', async () => {
    const transport = spawnScript(CLOSE_STDIN_AND_STAY);
    await firstMessage(transport);

    transport.send({ ping: 1 });
    transport.send({ ping: 2 });
    await Bun.sleep(300);

    expect(transport.status).toBe('writable');
    const end = await transport.close();
    expect(end.cause).toBe('requested');
    expect(end.communicationFailure).toBeUndefined();
  });

  it('drives a process lifecycle through start, crash and stop', async () => {
    const outcomes: ProcessRunOutcome[] = [];
    const handle = createProcessLifecycle({
      spawn: { command: process.execPath, args: ['-e', READY_AND_STAY], cwd: process.cwd() },
      healthTimeoutMs: 10_000,
      onExit: (outcome) => outcomes.push(outcome),
    });
    openLifecycles.add(handle);

    await handle.start();
    expect(handle.state).toBe('running');
    await handle.transport!.close();
    await waitUntil(() => outcomes.length === 1);
    expect(handle.state).toBe('stopped');

    await handle.start();
    expect(handle.generation).toBe(2);
    await handle.stop();
    expect(handle.state).toBe('stopped');
    expect(outcomes.map((outcome) => [outcome.generation, outcome.readiness, outcome.end.cause])).toEqual([
      [1, 'ready', 'requested'],
      [2, 'ready', 'requested'],
    ]);
    expect(outcomes[1]!.end.exit).toEqual({ kind: 'exited', code: null, signal: 'SIGTERM' });
  });

  it('reports a lifecycle run that crashes after readiness as crashed', async () => {
    const outcomes: ProcessRunOutcome[] = [];
    const handle = createProcessLifecycle({
      spawn: {
        command: process.execPath,
        args: ['-e', `process.stdout.write('{"ready":true}\\n', () => process.exit(3));`],
        cwd: process.cwd(),
      },
      healthTimeoutMs: 10_000,
      onExit: (outcome) => outcomes.push(outcome),
    });
    openLifecycles.add(handle);

    await handle.start();
    await waitUntil(() => outcomes.length === 1);

    expect(handle.state).toBe('crashed');
    expect(outcomes[0]!.end.cause).toBe('unexpected');
    expect(outcomes[0]!.end.exit).toEqual({ kind: 'exited', code: 3, signal: null });
  });

  it('reports a stdout held by a grandchild as truncated at the drain deadline, apart from the exit', async () => {
    const transport = spawnScript(GRANDCHILD_HOLDS_STDOUT, { drainTimeoutMs: 300 });
    await grandchildPid(transport);

    const end = await transport.ended;

    expect(end.exit).toEqual({ kind: 'exited', code: 0, signal: null });
    expect(end.drain).toEqual({ kind: 'timed-out', discardedChars: 'partial'.length, stdoutComplete: false });
  });
});
