/**
 * Provider-session currency across a suppressed native resume (CLI adapter).
 *
 * Same producer chain as the SDK adapter, driven through the real CLI connector
 * and session: an idle agent seeded with a stored resume target takes a first
 * dispatch that degrades to fresh-with-history. The rotation is announced on the
 * movement seam before the dispatch, while the session still reports the seeded
 * target as its authoritative ID and `createMessageHandle` has already emitted
 * `user_message.sent` — the event payload enrichment runs on. Nothing in that
 * window may point the session row back at the abandoned thread.
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

const AGENT_ID = 'agent-suppressed-resume';
const ADAPTER_ID = 'adapter-test';
const SESSION_ID = 'session-suppressed-resume';
const RESUME_TARGET = 'stored-provider-session';

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
 * Collect every provider-session movement announced on the seam.
 * @returns Collected payloads and an unsubscribe callback
 */
function captureMovements(): { movements: AdapterSessionMoved[]; unsubscribe: () => void } {
  const movements: AdapterSessionMoved[] = [];
  const unsubscribe = MakaioBus.on(AgentSubjects.adapterSession.moved, ({ payload }) => {
    movements.push(payload);
  });
  return { movements, unsubscribe };
}

/** @returns Argv of the first spawned CLI subprocess */
function spawnedArgs(): string[] {
  const args = transportStub.createStdioTransport.mock.calls[0]?.[0] as string[] | undefined;
  if (!args) throw new Error('No CLI spawn recorded');
  return args;
}

/** @returns Session ID the CLI was pinned to on its first spawn */
function pinnedSessionId(): string {
  const args = spawnedArgs();
  const pinned = args[args.indexOf('--session-id') + 1];
  if (pinned === undefined) throw new Error('CLI spawn carried no --session-id');
  return pinned;
}

describe('ClaudeCodeCliAgent provider-session currency on a suppressed native resume', () => {
  let capture: { movements: AdapterSessionMoved[]; unsubscribe: () => void };
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

  it('never re-announces the abandoned resume target as confirmed currency', async () => {
    agent = await makeResumeArmedAgent();
    // Idle start: the session seeds its identity from the stored target and
    // reports it as authoritative before any subprocess exists.
    await expect(agent.initialize()).resolves.toBe(RESUME_TARGET);

    await MakaioBus.request(AgentSubjects.sendMessage, {
      agentId: AGENT_ID,
      adapterId: ADAPTER_ID,
      message: 'first turn after a degrade',
      sessionContext: {
        nativeLocality: { kind: 'degrade', reason: 'transforms-present' },
        isFirstTurn: true,
      },
    });

    // The suppressed dispatch minted a fresh pinned identity; the provider
    // adopts it and confirms through `system.init`.
    const pinned = pinnedSessionId();
    expect(pinned).not.toBe(RESUME_TARGET);
    transportHarness.emitMessage({ type: 'system', subtype: 'init', session_id: pinned } as SDKMessage);
    await vi.waitFor(() => {
      expect(capture.movements.filter((movement) => movement.confirmed).length).toBeGreaterThanOrEqual(1);
    });

    // The rotation is announced first; every confirmed announcement that follows
    // names the fresh pinned session, never the abandoned target. Repeats are
    // expected — concurrent enrichment calls can announce the same identity more
    // than once, and the currency handler change-guards them.
    expect(capture.movements[0]).toMatchObject({ agentId: AGENT_ID, sessionId: SESSION_ID, confirmed: false });
    const confirmed = capture.movements.filter((movement) => movement.confirmed);
    expect(confirmed.length).toBeGreaterThanOrEqual(1);
    expect(confirmed.map((movement) => movement.adapterSessionId)).toEqual(confirmed.map(() => pinned));
  });

  it('announces the resumed session as currency once the provider confirms it', async () => {
    // Counter-check: a dispatch that keeps native resume never rotates, so the
    // stored target stays the agent's currency.
    agent = await makeResumeArmedAgent();
    await agent.initialize();

    await MakaioBus.request(AgentSubjects.sendMessage, {
      agentId: AGENT_ID,
      adapterId: ADAPTER_ID,
      message: 'first turn with native resume',
      sessionContext: { nativeLocality: { kind: 'native' } },
    });

    // No rotation: the CLI resumed the stored thread, and the provider confirms
    // that very session. Currency becomes confirmed on the provider's word —
    // before it arrives the seam stays silent rather than guessing.
    expect(spawnedArgs()).toContain('--resume');
    expect(capture.movements).toEqual([]);
    transportHarness.emitMessage({ type: 'system', subtype: 'init', session_id: RESUME_TARGET } as SDKMessage);
    await vi.waitFor(() => {
      expect(capture.movements.length).toBeGreaterThanOrEqual(1);
    });

    expect(capture.movements.every((movement) => movement.confirmed)).toBe(true);
    expect(capture.movements[0]).toMatchObject({ adapterSessionId: RESUME_TARGET, confirmed: true });
  });
});
