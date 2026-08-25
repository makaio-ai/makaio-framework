/**
 * Cases 206d (qwen arm) and 226 — the class this connector may claim, and the
 * generation retirement that can cap it (I33).
 *
 * Driven against the real rebuild the connector performs when a system prompt
 * arrives after an idle initialization: `initialize()` followed by
 * `initialize({ systemPrompt })` produces two ACP connections and one kill. Only
 * the ACP spawn is substituted, because the seam under test is what the connector
 * does with the exit observation the shared client hands it — not how that client
 * produces one.
 */
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTOR_EXIT_OBSERVATION_MS } from '@makaio/ai-adapters-core';
import type { AcpConnectionHandle } from '@makaio/ai-adapters-acp-client';
import type { CreateTerminalRequest as TerminalRequest } from '@agentclientprotocol/sdk';

/** Terminal children are the only thing spawned here; the ACP process is stubbed. */
const mockTerminalSpawn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, spawn: mockTerminalSpawn };
});

/**
 * A spawned child that starts and then never answers a kill.
 *
 * The unobservable end, which is what makes a class dishonest: the signal was sent,
 * the manager dropped the terminal, and nothing ever confirmed the process died.
 * @returns Fake child process with a kill spy.
 */
function makeUnreapableChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return child;
}

/**
 * Serve one fake child from the spawn seam, announcing its start when asked for.
 *
 * The `spawn` event has to be emitted from inside the call, not at construction:
 * `waitForSpawn` subscribes after the spawn returns, and an event fired before that
 * is an event nobody is listening for.
 * @param child - Fake child every terminal spawn resolves to.
 */
function serveTerminalChild(child: ReturnType<typeof makeUnreapableChild>): void {
  mockTerminalSpawn.mockImplementation(() => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  });
}

import { QwenAcpNamespace } from '../namespaces/index.js';
import { QwenAcpConnector } from '../connector.js';

const mockCreateAcpConnection = vi.hoisted(() => vi.fn());

/** Every `createAcpConnection` call the connector made, newest last. */
const acpCalls: Array<{
  clientFactory: (agent: unknown) => unknown;
  onExit: (code: number | null) => void;
}> = [];

vi.mock('@makaio/ai-adapters-acp-client', async () => {
  const actual = await vi.importActual<typeof import('@makaio/ai-adapters-acp-client')>(
    '@makaio/ai-adapters-acp-client',
  );
  return { ...actual, createAcpConnection: mockCreateAcpConnection };
});

const NATIVE_AUTH = { processEnv: {}, connectorDeliveries: [], configInheritance: 'auth-only' as const };
const SYSTEM_PROMPT = 'Follow the repository policies strictly.';

/**
 * Build an ACP handle whose process exit is settled by the test.
 * @param sessionId - Session id the handshake reports.
 * @param exited - Exit observation for the spawned process.
 * @returns Handle in the shape `createAcpConnection` resolves with.
 */
function makeHandle(sessionId: string, exited: Promise<number | null>): AcpConnectionHandle {
  return {
    // @ts-expect-error -- partial shim: ClientSideConnection has private fields and many unused members
    connection: {
      initialize: vi.fn().mockResolvedValue(undefined),
      newSession: vi.fn().mockResolvedValue({ sessionId }),
      cancel: vi.fn().mockResolvedValue(undefined),
      prompt: vi.fn().mockResolvedValue(undefined),
    },
    kill: vi.fn(),
    exited,
  };
}

/**
 * Queue one `createAcpConnection` outcome and record what the connector passed in.
 *
 * The exit callback and the client factory are the two things the connector hands
 * the shared client, and both are seams the tests below drive: an ACP process's exit
 * arrives through the first, and the terminal children the agent opens are created
 * through the second.
 * @param handle - Handle this call resolves with.
 */
function queueConnection(handle: AcpConnectionHandle): void {
  mockCreateAcpConnection.mockImplementationOnce(
    async (
      clientFactory: (agent: unknown) => unknown,
      options: { onExit: (code: number | null) => void },
    ): Promise<AcpConnectionHandle> => {
      acpCalls.push({ clientFactory, onExit: options.onExit });
      return handle;
    },
  );
}

/** A promise plus its settler, for driving an exit at an exact moment. */
function deferredExit(): { promise: Promise<number | null>; settle: () => void } {
  let settle: () => void = () => {};
  const promise = new Promise<number | null>((resolve) => {
    settle = () => resolve(0);
  });
  return { promise, settle };
}

/**
 * Create a connector configured for unit tests.
 * @returns A connector on a scoped bus with native auth.
 */
async function makeConnector(): Promise<QwenAcpConnector> {
  return new QwenAcpConnector({
    bus: await QwenAcpNamespace.scopedBus(),
    adapterId: 'adapter-1',
    adapterName: 'qwen-acp',
    agentId: 'agent-1',
    sessionId: 'session-1',
    model: 'qwen3-coder',
    cwd: tmpdir(),
    env: {},
    adapterAuth: NATIVE_AUTH,
    allowedDirectories: ['/workspace/project'],
  });
}

describe('QwenAcpConnector teardown evidence', () => {
  beforeEach(() => {
    mockCreateAcpConnection.mockReset();
    acpCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Case 206d, qwen arm.
  it('reports `exited` from the observed end of the process it spawned', async () => {
    const exit = deferredExit();
    mockCreateAcpConnection.mockResolvedValueOnce(makeHandle('session-1', exit.promise));
    const connector = await makeConnector();
    await connector.initialize();

    // The kill is what produces the exit in production; settling here stands in
    // for the child's own `exit` event arriving after it.
    exit.settle();

    await expect(connector.close()).resolves.toEqual({ evidence: 'exited' });
  });

  // The cancel stage's own bound: a close that got its acknowledgement must not
  // leave the expiry timer armed. Asserted on the timer count rather than on
  // elapsed time, because a leaked timer is invisible to a report — it only shows
  // up as a process that will not exit for the rest of the budget.
  it('arms no timer past a cancel the agent acknowledged', async () => {
    const exit = deferredExit();
    mockCreateAcpConnection.mockResolvedValueOnce(makeHandle('session-1', exit.promise));
    const connector = await makeConnector();
    await connector.initialize();
    exit.settle();

    vi.useFakeTimers();
    try {
      await expect(connector.close()).resolves.toEqual({ evidence: 'exited' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  // Case 206d, qwen timeout arm.
  it('reports `detached` when the end it asked for is not observed inside the budget', async () => {
    const neverExits = new Promise<number | null>(() => {});
    mockCreateAcpConnection.mockResolvedValueOnce(makeHandle('session-1', neverExits));
    const connector = await makeConnector();
    await connector.initialize();

    vi.useFakeTimers();
    try {
      const closing = connector.close();
      await vi.advanceTimersByTimeAsync(CONNECTOR_EXIT_OBSERVATION_MS);
      const report = await closing;
      expect(report.evidence).toBe('detached');
      expect(report.detail).toContain('qwen ACP process');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('QwenAcpConnector generation retirement (I33, case 226)', () => {
  beforeEach(() => {
    mockCreateAcpConnection.mockReset();
    acpCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('arm 1 — the rebuild awaits the predecessor exit before creating the replacement', async () => {
    const order: string[] = [];
    const firstExit = deferredExit();
    const firstHandle = makeHandle('session-initial', firstExit.promise);
    const secondHandle = makeHandle('session-with-prompt', Promise.resolve(0));
    mockCreateAcpConnection
      .mockImplementationOnce(async () => firstHandle)
      .mockImplementationOnce(async () => {
        order.push('replacement-created');
        return secondHandle;
      });

    const connector = await makeConnector();
    await connector.initialize();

    const rebuild = connector.initialize({ systemPrompt: SYSTEM_PROMPT });
    // Ordering, not a call count: the existing suite already satisfies "two
    // connections and one kill", so what has to be asserted is that the second
    // connection had *not* been created while the first end was unobserved.
    await vi.waitFor(() => {
      expect(firstHandle.kill).toHaveBeenCalledTimes(1);
    });
    expect(order).toEqual([]);

    order.push('predecessor-exit-observed');
    firstExit.settle();
    await rebuild;

    expect(order).toEqual(['predecessor-exit-observed', 'replacement-created']);
    await expect(connector.close()).resolves.toEqual({ evidence: 'exited' });
  });

  it('arm 2 — a predecessor exit that never arrives still completes the rebuild and caps the class', async () => {
    const neverExits = new Promise<number | null>(() => {});
    mockCreateAcpConnection
      .mockResolvedValueOnce(makeHandle('session-initial', neverExits))
      .mockResolvedValueOnce(makeHandle('session-with-prompt', Promise.resolve(0)));

    const connector = await makeConnector();
    await connector.initialize();

    vi.useFakeTimers();
    let rebuilt = false;
    try {
      const rebuild = connector.initialize({ systemPrompt: SYSTEM_PROMPT }).then(() => {
        rebuilt = true;
      });
      await vi.advanceTimersByTimeAsync(CONNECTOR_EXIT_OBSERVATION_MS);
      await rebuild;
    } finally {
      vi.useRealTimers();
    }

    // A stuck predecessor must not block a live agent.
    expect(rebuilt).toBe(true);
    expect(mockCreateAcpConnection).toHaveBeenCalledTimes(2);

    // The live generation's own end *is* observed, and the class is still capped,
    // because the unretired predecessor may still be running.
    const report = await connector.close();
    expect(report.evidence).toBe('detached');
    expect(report.detail).toContain('qwen ACP process generation 1');
  });

  it('arm 3 — a teardown arriving mid-rebuild reports the unretired generation, not `exited`', async () => {
    const firstExit = deferredExit();
    const firstHandle = makeHandle('session-initial', firstExit.promise);
    const secondHandle = makeHandle('session-with-prompt', Promise.resolve(0));
    mockCreateAcpConnection.mockResolvedValueOnce(firstHandle).mockResolvedValueOnce(secondHandle);

    const connector = await makeConnector();
    await connector.initialize();

    const rebuild = connector.initialize({ systemPrompt: SYSTEM_PROMPT });
    await vi.waitFor(() => {
      expect(firstHandle.kill).toHaveBeenCalledTimes(1);
    });

    // The teardown lands while the predecessor's retirement is still in flight —
    // the window in which nothing has been proven and nothing may be claimed.
    const report = await connector.close();
    expect(report.evidence).toBe('detached');
    expect(report.detail).toContain('qwen ACP process generation 1');

    firstExit.settle();
    // The rebuild finds the connector terminated when its retirement returns and
    // refuses to continue. Spawning a replacement here would leak a process whose
    // exit the termination guard then discards, and report a class for neither.
    await expect(rebuild).rejects.toThrow(/already been terminated/);
    expect(mockCreateAcpConnection).toHaveBeenCalledTimes(1);
    // Exactly one connector-owned generation was killed: the predecessor.
    expect(firstHandle.kill).toHaveBeenCalledTimes(1);
    expect(secondHandle.kill).not.toHaveBeenCalled();
  });

  it('arm 4 — the synchronous abort records the unretired generation and caps the class the same way', async () => {
    const neverExits = new Promise<number | null>(() => {});
    mockCreateAcpConnection.mockResolvedValueOnce(makeHandle('session-initial', neverExits));

    const connector = await makeConnector();
    await connector.initialize();

    // Synchronous by the connector contract: it cannot await the end it signals.
    connector.abort();

    const report = await connector.close();
    expect(report.evidence).toBe('detached');
    expect(report.detail).toContain('qwen ACP process generation 1');
  });

  it('arm 5 — a failed init immediately caps teardown while its killed process exit is unsettled', async () => {
    // The generation that never reaches the connector's handle field: the process is
    // spawned, the handshake then fails, and the local variable is the only thing
    // holding it. The failed-init path must still book that local generation before
    // returning its error, so a later close cannot claim `released` while the
    // process end remains unobserved (C4).
    const exit = deferredExit();
    const handle = makeHandle('session-never-agreed', exit.promise);
    handle.connection.newSession = vi.fn().mockRejectedValue(new Error('qwen refused the session'));
    mockCreateAcpConnection.mockResolvedValueOnce(handle);

    const connector = await makeConnector();
    await expect(connector.initialize()).rejects.toThrow('qwen refused the session');

    // The failed init killed the process it spawned…
    expect(handle.kill).toHaveBeenCalledTimes(1);
    // …and booked it, so the teardown that follows cannot claim the process is gone.
    const report = await connector.close();
    expect(report.evidence).toBe('detached');
    expect(report.detail).toContain('qwen ACP process generation 1');
  });

  it('reactively retires a failed-init generation after its exit settles, so a healthy retry is not capped', async () => {
    const failedExit = deferredExit();
    const failedHandle = makeHandle('session-never-agreed', failedExit.promise);
    failedHandle.connection.newSession = vi.fn().mockRejectedValue(new Error('qwen refused the session'));
    const healthyHandle = makeHandle('session-healthy', Promise.resolve(0));
    mockCreateAcpConnection.mockResolvedValueOnce(failedHandle).mockResolvedValueOnce(healthyHandle);

    const connector = await makeConnector();
    await expect(connector.initialize()).rejects.toThrow('qwen refused the session');

    // The first generation is still unproven until its existing exit observation
    // settles; abandoning it must not wait for that observation.
    expect(failedHandle.kill).toHaveBeenCalledTimes(1);
    failedExit.settle();
    await Promise.resolve();

    await connector.initialize();

    // The retry owns a separate, observed generation. The abandoned predecessor
    // no longer caps this report once its own retained exit promise has settled.
    await expect(connector.close()).resolves.toEqual({ evidence: 'exited' });
    expect(healthyHandle.kill).toHaveBeenCalledTimes(1);
  });
});

describe('QwenAcpConnector generation-aware exit handling (case 226, G5)', () => {
  beforeEach(() => {
    mockCreateAcpConnection.mockReset();
    acpCalls.length = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('leaves the connector live when a superseded generation reports the exit it was asked for', async () => {
    const firstExit = deferredExit();
    const firstHandle = makeHandle('session-initial', firstExit.promise);
    const secondHandle = makeHandle('session-with-prompt', Promise.resolve(0));
    queueConnection(firstHandle);
    queueConnection(secondHandle);

    const connector = await makeConnector();
    await connector.initialize();
    const rebuild = connector.initialize({ systemPrompt: SYSTEM_PROMPT });
    await vi.waitFor(() => {
      expect(firstHandle.kill).toHaveBeenCalledTimes(1);
    });

    // The predecessor's own exit — the one the rebuild is waiting on. It is not a
    // fault: the connector asked for it. Treating it as terminal aborted a connector
    // whose replacement was already starting, and the wave made that ordering
    // reliable rather than racy.
    acpCalls[0].onExit(0);
    firstExit.settle();
    await rebuild;

    // Still alive, still on generation 2, and its own end is what the close reports.
    expect(mockCreateAcpConnection).toHaveBeenCalledTimes(2);
    await expect(connector.close()).resolves.toEqual({ evidence: 'exited' });
    expect(secondHandle.kill).toHaveBeenCalledTimes(1);
  });

  it('still treats the current generation exit as fatal', async () => {
    const handle = makeHandle('session-1', Promise.resolve(0));
    queueConnection(handle);

    const connector = await makeConnector();
    await connector.initialize();

    // The live generation dying under us is exactly what the callback is for, and
    // narrowing it to the current generation must not narrow it to nothing.
    acpCalls[0].onExit(1);

    await vi.waitFor(() => {
      expect(handle.kill).toHaveBeenCalledTimes(1);
    });
    const report = await connector.close();
    expect(report.detail).toContain('An earlier teardown');
  });
});

describe('QwenAcpConnector terminal retirement (I33, G6)', () => {
  beforeEach(() => {
    mockCreateAcpConnection.mockReset();
    acpCalls.length = 0;
    mockTerminalSpawn.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Open one terminal through the connector's own ACP client.
   *
   * Driven the way the agent drives it — a `createTerminal` request through the real
   * client and the real manager — because the claim under test is about resources
   * this connector spawned, and a stand-in for the manager would not have spawned
   * anything.
   * @param connector - Initialized connector whose client is asked.
   */
  async function openTerminal(connector: QwenAcpConnector): Promise<{
    readonly client: {
      createTerminal: (params: TerminalRequest) => Promise<{ terminalId: string }>;
      releaseTerminal: (params: { terminalId: string; sessionId: string }) => Promise<Record<string, never>>;
    };
    readonly terminalId: string;
  }> {
    const client = acpCalls[0].clientFactory({}) as {
      createTerminal: (params: TerminalRequest) => Promise<{ terminalId: string }>;
      releaseTerminal: (params: { terminalId: string; sessionId: string }) => Promise<Record<string, never>>;
    };
    const { terminalId } = await client.createTerminal({
      command: 'node',
      args: ['-e', 'setInterval(() => {}, 1_000)'],
      outputByteLimit: 1024,
      env: [],
      sessionId: 'session-1',
    });
    expect(connector).toBeDefined();
    return { client, terminalId };
  }

  it('caps the class when a released terminal child is never observed to end', async () => {
    queueConnection(makeHandle('session-1', Promise.resolve(0)));
    const terminal = makeUnreapableChild();
    serveTerminalChild(terminal);

    const connector = await makeConnector();
    await connector.initialize();
    await openTerminal(connector);

    vi.useFakeTimers();
    try {
      const closing = connector.close();
      await vi.advanceTimersByTimeAsync(CONNECTOR_EXIT_OBSERVATION_MS);
      const report = await closing;

      // The ACP process's own end *was* observed, so the main class is `exited`. The
      // terminal child was SIGKILLed and never reaped, and a class that ignored it
      // would claim this runtime is done talking while one of its children may still
      // be running.
      expect(terminal.kill).toHaveBeenCalledWith('SIGKILL');
      expect(report.evidence).toBe('detached');
      expect(report.detail).toContain('qwen terminal process generation 1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the class when an agent-released terminal child is never observed to end', async () => {
    queueConnection(makeHandle('session-1', Promise.resolve(0)));
    const terminal = makeUnreapableChild();
    serveTerminalChild(terminal);

    const connector = await makeConnector();
    await connector.initialize();
    const { client, terminalId } = await openTerminal(connector);
    await client.releaseTerminal({ terminalId, sessionId: 'session-1' });

    vi.useFakeTimers();
    try {
      const closing = connector.close();
      await vi.advanceTimersByTimeAsync(CONNECTOR_EXIT_OBSERVATION_MS);
      const report = await closing;

      expect(terminal.kill).toHaveBeenCalledTimes(1);
      expect(terminal.kill).toHaveBeenCalledWith('SIGKILL');
      expect(report.evidence).toBe('detached');
      expect(report.detail).toContain('qwen terminal process generation 1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the main class intact when the terminal child is observed to end', async () => {
    queueConnection(makeHandle('session-1', Promise.resolve(0)));
    const terminal = makeUnreapableChild();
    // A kill that lands: the child closes, so its end is evidence like any other.
    terminal.kill.mockImplementation(() => {
      terminal.emit('exit', null, 'SIGKILL');
      terminal.emit('close');
      return true;
    });
    serveTerminalChild(terminal);

    const connector = await makeConnector();
    await connector.initialize();
    await openTerminal(connector);

    await expect(connector.close()).resolves.toEqual({ evidence: 'exited' });
  });

  it('keeps the class exited when an agent-released terminal child is observed to end', async () => {
    queueConnection(makeHandle('session-1', Promise.resolve(0)));
    const terminal = makeUnreapableChild();
    terminal.kill.mockImplementation(() => {
      terminal.emit('exit', null, 'SIGKILL');
      terminal.emit('close');
      return true;
    });
    serveTerminalChild(terminal);

    const connector = await makeConnector();
    await connector.initialize();
    const { client, terminalId } = await openTerminal(connector);
    await client.releaseTerminal({ terminalId, sessionId: 'session-1' });

    await expect(connector.close()).resolves.toEqual({ evidence: 'exited' });
    expect(terminal.kill).toHaveBeenCalledTimes(1);
  });
});
