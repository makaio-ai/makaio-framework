/**
 * Provider-session currency across an immediate-mode restart (CLI adapter).
 *
 * An immediate message supersedes the live subprocess, and the CLI restarts
 * without `--resume`: the confirmed provider thread is abandoned for a freshly
 * pinned identity that stays unconfirmed until the replacement's `system.init`.
 * The executor's pre-dispatch rotation check cannot see this — it ran while the
 * session was still confirmed on the old thread — so the session must announce
 * the movement itself, before the replacement subprocess is spawned.
 */
import { AgentTeardownArbiter } from '@makaio/ai-adapters-core';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, type AdapterSessionMoved } from '@makaio/contracts';
import type { SDKMessage } from '@makaio/client-claude-code';

const transportStub = vi.hoisted(() => {
  // Settled from `close()`, exactly as the real transport settles it from the
  // child's `exit` event after the kill: a teardown here reaches its class
  // instead of waiting out the whole observation budget.
  let settleExit: (code: number | null) => void = () => {};
  const exited = new Promise<number | null>((resolve) => {
    settleExit = resolve;
  });
  return {
    transport: {
      onMessage: vi.fn(),
      onError: vi.fn(),
      close: vi.fn(() => settleExit(null)),
      exited,
    },
    createStdioTransport: vi.fn(),
  };
});

vi.mock('../utils/createStdioTransport.js', () => ({
  createStdioTransport: transportStub.createStdioTransport,
}));

import { ClaudeCodeCliAgent } from '../agent.js';
import { ClaudeCliConnector } from '../connector.js';
import { ClaudeCodeCliConnectorNamespace, type ClaudeCodeCliConnectorBus } from '../namespace/index.js';
import type { ClaudeCliAgentConfig } from '../types.js';
import { makeTransportHarness } from './fixtures/transport-harness.js';

const transportHarness = makeTransportHarness(transportStub.transport);

const AGENT_ID = 'agent-immediate-restart';
const ADAPTER_ID = 'adapter-test';
const SESSION_ID = 'session-immediate-restart';
const RESUME_TARGET = 'stored-provider-session';

/** One announced movement plus the number of subprocess spawns that preceded it. */
interface ObservedMovement {
  payload: AdapterSessionMoved;
  spawnsBefore: number;
}

/**
 * Create a ClaudeCodeCliAgent seeded with a stored provider-session resume target.
 * @returns Agent wired to the real CLI connector
 */
async function makeResumeArmedAgent(): Promise<ClaudeCodeCliAgent> {
  const adapterBus = await ClaudeCodeCliConnectorNamespace.scopedBus();
  return new ClaudeCodeCliAgent({
    adapterBus,
    teardownArbiter: new AgentTeardownArbiter(),
    globalBus: MakaioBus,
    adapterId: ADAPTER_ID,
    adapterName: 'claude-code-cli',
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    cwd: os.tmpdir(),
    model: 'claude-sonnet-4-20250514',
    env: {},
    capabilities: [],
    nativeTools: [],
    resumeAdapterSessionId: RESUME_TARGET,
    configFactory: async (input) => ({
      ...input,
      bus: input.bus as ClaudeCodeCliConnectorBus,
      cwd: input.cwd ?? os.tmpdir(),
      model: input.model ?? 'claude-sonnet-4-20250514',
      env: input.env ?? {},
    }),
    connectorFactory: (config) => new ClaudeCliConnector(config as ClaudeCliAgentConfig),
  });
}

/**
 * Collect every announced movement together with the spawn count at that moment.
 *
 * The spawn count is what makes the ordering duty observable: a movement that
 * arrives while only the superseded subprocess has been spawned was announced
 * before the dispatch that abandons its provider thread.
 * @returns Collected observations and an unsubscribe callback
 */
function captureMovements(): { movements: ObservedMovement[]; unsubscribe: () => void } {
  const movements: ObservedMovement[] = [];
  const unsubscribe = MakaioBus.on(AgentSubjects.adapterSession.moved, ({ payload }) => {
    movements.push({ payload, spawnsBefore: transportStub.createStdioTransport.mock.calls.length });
  });
  return { movements, unsubscribe };
}

/**
 * Read the `--session-id` the CLI was pinned to on one spawn.
 * @param spawnIndex - Zero-based index of the recorded spawn
 * @returns Pinned session ID for that spawn
 */
function pinnedSessionId(spawnIndex: number): string {
  const args = transportStub.createStdioTransport.mock.calls[spawnIndex]?.[0] as string[] | undefined;
  if (!args) throw new Error(`No CLI spawn recorded at index ${spawnIndex}`);
  const sessionIdIndex = args.indexOf('--session-id');
  if (sessionIdIndex === -1) throw new Error('CLI spawn carried no --session-id');
  const pinned = args[sessionIdIndex + 1];
  if (pinned === undefined) throw new Error('CLI spawn carried no --session-id value');
  return pinned;
}

describe('ClaudeCodeCliAgent provider-session currency on an immediate-mode restart', () => {
  let capture: { movements: ObservedMovement[]; unsubscribe: () => void };
  let agent: ClaudeCodeCliAgent | undefined;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    transportHarness.reset();
    transportStub.createStdioTransport.mockReset();
    transportStub.createStdioTransport.mockImplementation(() => transportStub.transport);
    capture = captureMovements();
  });

  afterEach(async () => {
    capture.unsubscribe();
    await agent?.close();
    agent = undefined;
    MakaioBus.__resetHandlers?.();
  });

  it('announces the abandoned provider thread before respawning', async () => {
    agent = await makeResumeArmedAgent();
    await expect(agent.initialize()).resolves.toBe(RESUME_TARGET);

    // Turn 1 resumes the stored thread and the provider confirms it, so the
    // session row's currency is the thread the restart is about to abandon.
    await MakaioBus.request(AgentSubjects.sendMessage, {
      agentId: AGENT_ID,
      adapterId: ADAPTER_ID,
      message: 'first turn with native resume',
      sessionContext: { nativeLocality: { kind: 'native' } },
    });
    transportHarness.emitMessage({ type: 'system', subtype: 'init', session_id: RESUME_TARGET } as SDKMessage);
    await vi.waitFor(() => {
      expect(capture.movements.length).toBeGreaterThanOrEqual(1);
    });
    expect(capture.movements[0]?.payload).toMatchObject({ adapterSessionId: RESUME_TARGET, confirmed: true });

    // An immediate message queues while the turn is in flight; the connector
    // processes the queue at the next step boundary.
    await MakaioBus.request(AgentSubjects.sendMessage, {
      agentId: AGENT_ID,
      adapterId: ADAPTER_ID,
      message: 'supersede the live turn',
      deliveryMode: 'immediate',
      sessionContext: { nativeLocality: { kind: 'native' } },
    });
    expect(transportStub.createStdioTransport.mock.calls).toHaveLength(1);

    transportHarness.emitMessage({
      type: 'stream_event',
      uuid: 'stream-evt-1',
      session_id: RESUME_TARGET,
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    });
    transportHarness.emitMessage({
      type: 'stream_event',
      uuid: 'stream-evt-2',
      session_id: RESUME_TARGET,
      event: { type: 'content_block_stop', index: 0 },
    });

    await vi.waitFor(() => {
      expect(transportStub.createStdioTransport.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    // The restart minted a fresh pinned identity rather than resuming.
    expect(pinnedSessionId(1)).not.toBe(RESUME_TARGET);
    // The rotation was announced, and it was announced while only the superseded
    // subprocess existed — so the row stopped advertising the abandoned thread
    // before the replacement was asked to start a new one.
    const unconfirmed = capture.movements.filter((movement) => !movement.payload.confirmed);
    expect(unconfirmed).toHaveLength(1);
    expect(unconfirmed[0]).toMatchObject({
      spawnsBefore: 1,
      payload: { agentId: AGENT_ID, sessionId: SESSION_ID, confirmed: false },
    });
    // Nothing re-announced the abandoned thread afterwards.
    expect(
      capture.movements
        .slice(capture.movements.indexOf(unconfirmed[0]!))
        .filter((movement) => movement.payload.adapterSessionId === RESUME_TARGET),
    ).toEqual([]);
  });
});
