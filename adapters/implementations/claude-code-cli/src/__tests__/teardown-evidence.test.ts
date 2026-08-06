/**
 * Cases 206d (claude-code-cli arm) and 206 (I29 for this connector).
 *
 * The transport is substituted because the seam under test is what the session
 * does with the exit observation the transport hands it — the transport's own
 * production of that observation has its own suite over a real subprocess.
 */
import os from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { CONNECTOR_EXIT_OBSERVATION_MS, MessageHandle, UserMessageQueue } from '@makaio/ai-adapters-core';
import { TERMINAL_RESULT_DRAIN_TIMEOUT_MS } from '@makaio/ai-adapters-claude-shared';
import type { SDKMessage } from '@makaio/client-claude-code';

const transportStub = vi.hoisted(() => {
  const state = {
    /** Whether `close()` publishes the child's exit, as a real kill does. */
    publishExitOnClose: true,
    /** Failure the transport's own `close()` raises, when the test injects one. */
    closeFailure: undefined as Error | undefined,
    settleExit: (() => {}) as () => void,
    exited: Promise.resolve<number | null>(null),
    /** Replace the exit observation, so one test's settled exit is not another's. */
    resetExit(): void {
      state.exited = new Promise<number | null>((resolve) => {
        state.settleExit = () => resolve(null);
      });
    },
  };
  state.resetExit();
  return {
    state,
    transport: {
      onMessage: vi.fn(),
      onError: vi.fn(),
      close: vi.fn(() => {
        if (state.publishExitOnClose) state.settleExit();
        if (state.closeFailure !== undefined) throw state.closeFailure;
      }),
      // A getter, because each test installs its own observation.
      get exited(): Promise<number | null> {
        return state.exited;
      },
    },
  };
});

vi.mock('../utils/createStdioTransport.js', () => ({
  createStdioTransport: vi.fn(() => transportStub.transport),
}));

import { ClaudeCliSession } from '../session.js';
import { ClaudeConnectorTurn } from '../turn.js';
import { ClaudeCodeCliConnectorNamespace } from '../namespace/index.js';
import type { OnTurnCompleteCallback } from '../types.js';
import { makeTransportHarness } from './fixtures/transport-harness.js';

const transportHarness = makeTransportHarness(transportStub.transport);

/**
 * A terminal `result` message, used to complete the turn before a teardown.
 *
 * The teardown paths under test are the *process* ones. Leaving a turn in flight
 * would instead exercise the terminal-result drain, which has its own suite and
 * would only add a timer to advance here.
 * @returns One successful SDK result message.
 */
function terminalResult(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'done',
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
      service_tier: 'standard',
    },
    modelUsage: {},
    permission_denials: [],
    uuid: 'result-teardown',
    session_id: 'session-teardown',
  };
}

/** Build one enqueued user message. */
function makeHandle(): MessageHandle {
  return new MessageHandle(
    'message-teardown',
    { role: 'user', blocks: [{ type: 'text', content: 'hello' }], message: 'hello' },
    'enqueue',
  );
}

/**
 * Create a session over the substituted transport.
 * @param onTurnComplete - Turn completion callback, for the arms that wait on one.
 * @returns A session that has not yet spawned anything.
 */
async function makeSession(onTurnComplete?: OnTurnCompleteCallback): Promise<ClaudeCliSession> {
  return new ClaudeCliSession({
    bus: await ClaudeCodeCliConnectorNamespace.scopedBus(),
    adapterId: 'adapter-1',
    adapterName: 'claude-code-cli',
    agentId: 'agent-1',
    model: 'claude-sonnet',
    cwd: os.tmpdir(),
    env: { PATH: '/usr/bin' },
    binaryPath: '/usr/bin/claude',
    ...(onTurnComplete !== undefined ? { onTurnComplete } : {}),
  });
}

/**
 * Create a session whose turn is still awaiting its terminal result.
 *
 * The close path then has a turn to finalise, which is the stage the finalisation
 * arm injects a failure into.
 * @returns The session under test, with one turn in flight.
 */
async function makeSessionWithTurnInFlight(): Promise<ClaudeCliSession> {
  const session = await makeSession();
  const queue = new UserMessageQueue();
  queue.enqueue(makeHandle());
  await session.processQueue(queue);
  return session;
}

/**
 * Create a session and drive it far enough to own a spawned turn process.
 * @returns The session under test.
 */
async function makeStartedSession(): Promise<ClaudeCliSession> {
  const completed = vi.fn();
  const session = await makeSession(completed);
  const queue = new UserMessageQueue();
  queue.enqueue(makeHandle());
  await session.processQueue(queue);
  transportHarness.emitMessage(terminalResult());
  await vi.waitFor(() => {
    expect(completed).toHaveBeenCalled();
  });
  return session;
}

describe('ClaudeCliSession teardown evidence', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    transportHarness.reset();
    transportStub.state.publishExitOnClose = true;
    transportStub.state.closeFailure = undefined;
    transportStub.state.resetExit();
  });

  // Case 206d, claude-code-cli arm.
  it('reports `exited` from the observed end of the turn process it spawned', async () => {
    const session = await makeStartedSession();

    await expect(session.close()).resolves.toEqual({ evidence: 'exited' });
    expect(transportStub.transport.close).toHaveBeenCalled();
  });

  // Case 206d, claude-code-cli timeout arm.
  it('reports `detached` when the kill it sent is never observed to land', async () => {
    transportStub.state.publishExitOnClose = false;
    const session = await makeStartedSession();

    vi.useFakeTimers();
    try {
      const closing = session.close();
      await vi.advanceTimersByTimeAsync(CONNECTOR_EXIT_OBSERVATION_MS);
      const report = await closing;
      expect(report.evidence).toBe('detached');
      expect(report.detail).toContain('claude CLI turn process');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports `released` when no turn process was ever spawned', async () => {
    const session = await makeSession();

    await expect(session.close()).resolves.toEqual({ evidence: 'released' });
  });

  // Case 206, claude-code-cli arm: the swallowed turn-finalisation stage.
  it('claims no observed class when finalising the interrupted turn failed unaccounted for (I29)', async () => {
    const finishFailure = new Error('turn could not be finalised');
    vi.spyOn(ClaudeConnectorTurn.prototype, 'finishOnError').mockRejectedValue(finishFailure);
    // A turn still in flight, because a completed one hands finalisation to the
    // result path and this stage never runs.
    const session = await makeSessionWithTurnInFlight();

    vi.useFakeTimers();
    try {
      const closing = session.close();
      await vi.advanceTimersByTimeAsync(TERMINAL_RESULT_DRAIN_TIMEOUT_MS);
      const report = await closing;

      // The exit *was* published by the kill, so reading only the exit promise
      // would report `exited`. The stage that failed is caught where it happens —
      // the other caller is an error listener with nobody to reject to — so it has
      // to be handed back, and a session that swallowed it would claim `exited`
      // over a turn it never finalised.
      expect(report.evidence).toBe('unknown');
      expect(report.detail).toContain('turn finalisation failed');
      expect(report.detail).toContain('turn could not be finalised');
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  // Case 206, claude-code-cli arm: the swallowed transport-close stage.
  it('claims no observed class when its own transport close failed unaccounted for (I29)', async () => {
    transportStub.state.closeFailure = new Error('kill signal could not be delivered');
    const session = await makeStartedSession();

    const report = await session.close();

    // The end *was* published, so a sweep that read only the exit promise would
    // report `exited` here. It may not: the session cannot tell whether its own
    // kill landed.
    expect(report.evidence).toBe('unknown');
    expect(report.detail).toContain('transport close failed');
  });
});
