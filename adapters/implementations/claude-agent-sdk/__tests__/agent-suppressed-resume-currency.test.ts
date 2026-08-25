/**
 * Provider-session currency across a suppressed native resume (SDK adapter).
 *
 * Exercises the whole producer chain with the real connector and session: an
 * idle agent seeded with a stored resume target takes a first dispatch that
 * degrades to fresh-with-history. The rotation is announced on the movement
 * seam *before* the dispatch, while the session still reports the seeded target
 * as its authoritative ID — and `createMessageHandle` emits `user_message.sent`
 * (which drives payload enrichment) before queue processing consumes that
 * target. The session row must not be pointed back at the abandoned thread in
 * that window.
 */
import { AgentTeardownArbiter } from '@makaio/ai-adapters-core';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, type AdapterSessionMoved } from '@makaio/contracts';
import type { OptionalResult } from '@makaio/core';

const queryHarness = vi.hoisted(() => {
  const query = vi.fn();
  return {
    query,
    reset: () => {
      query.mockReset();
    },
  };
});

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  Options: class Options {},
  query: queryHarness.query,
}));

import { ClaudeCodeConnectorNamespace, type ClaudeCodeConnectorBus } from '../src/namespace/index.js';
import { ClaudeCodeAgent } from '../src/agent.js';
import { ClaudeSdkConnector } from '../src/connector.js';
import type { ClaudeAgentConfig } from '../src/types/index.js';
import { installDefaultQueryImpl } from './fixtures/query-harness.js';

const AGENT_ID = 'agent-suppressed-resume';
const ADAPTER_ID = 'adapter-test';
const SESSION_ID = 'session-suppressed-resume';
const RESUME_TARGET = 'stored-provider-session';

/**
 * Create a ClaudeCodeAgent seeded with a stored provider-session resume target.
 * @returns Agent wired to the real SDK connector
 */
async function makeResumeArmedAgent(): Promise<ClaudeCodeAgent> {
  const adapterBus = await ClaudeCodeConnectorNamespace.scopedBus();
  return new ClaudeCodeAgent({
    adapterBus,
    teardownArbiter: new AgentTeardownArbiter(),
    globalBus: MakaioBus,
    adapterId: ADAPTER_ID,
    adapterName: 'claude-agent-sdk',
    machineId: 'test-machine',
    ownerInstanceId: 'test-owner-instance',
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
      bus: input.bus as ClaudeCodeConnectorBus,
      cwd: input.cwd ?? os.tmpdir(),
      model: input.model ?? 'claude-sonnet-4-20250514',
      env: input.env ?? {},
    }),
    connectorFactory: (config) =>
      new ClaudeSdkConnector({
        ...(config as ClaudeAgentConfig),
        clientId: config.clientId ?? 'claude-code',
        requestSessionAccountObservation: async (): Promise<OptionalResult<never>> => ({ handled: false }),
      }),
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

describe('ClaudeCodeAgent provider-session currency on a suppressed native resume', () => {
  let capture: { movements: AdapterSessionMoved[]; unsubscribe: () => void };
  let agent: ClaudeCodeAgent | undefined;

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    queryHarness.reset();
    installDefaultQueryImpl(queryHarness.query);
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
    // Idle start: the eagerly created query is armed with the stored target, so
    // the connector reports it as authoritative before any provider round trip.
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
    await vi.waitFor(() => {
      expect(capture.movements.length).toBeGreaterThanOrEqual(2);
    });

    // The dispatch abandoned the stored target: no announcement may name it as
    // the session row's confirmed currency, at any point in the sequence.
    expect(
      capture.movements.filter((movement) => movement.confirmed && movement.adapterSessionId === RESUME_TARGET),
    ).toEqual([]);

    // The rotation is announced first, and the provider's own `system.init` ID
    // is what finally becomes confirmed currency. Repeats are expected —
    // concurrent enrichment calls can announce the same identity more than once,
    // and the currency handler change-guards them.
    expect(capture.movements[0]).toMatchObject({ agentId: AGENT_ID, sessionId: SESSION_ID, confirmed: false });
    const confirmed = capture.movements.filter((movement) => movement.confirmed);
    expect(confirmed.length).toBeGreaterThanOrEqual(1);
    expect(new Set(confirmed.map((movement) => movement.adapterSessionId)).size).toBe(1);
  });

  it('announces the resumed session as currency once the provider confirms it', async () => {
    // Counter-check: a dispatch that keeps native resume never rotates, so the
    // stored target becomes confirmed currency through `system.init` as usual.
    agent = await makeResumeArmedAgent();
    await agent.initialize();

    await MakaioBus.request(AgentSubjects.sendMessage, {
      agentId: AGENT_ID,
      adapterId: ADAPTER_ID,
      message: 'first turn with native resume',
      sessionContext: { nativeLocality: { kind: 'native' } },
    });
    await vi.waitFor(() => {
      expect(capture.movements.filter((movement) => movement.confirmed).length).toBeGreaterThanOrEqual(1);
    });

    expect(capture.movements.every((movement) => movement.confirmed)).toBe(true);
    expect(capture.movements[0]).toMatchObject({ adapterSessionId: RESUME_TARGET, confirmed: true });
  });
});
