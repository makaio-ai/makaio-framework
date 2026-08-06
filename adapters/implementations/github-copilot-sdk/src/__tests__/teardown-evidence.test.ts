/**
 * Case 206, github-copilot-sdk arm — no observed class survives a swallowed
 * failure (I29).
 *
 * The connector's close releases three things and every one of them was silent.
 * They must keep running best-effort, because each releases something the ones
 * after it cannot; what may not survive is a class that claims a release nobody
 * could account for.
 *
 * **Only the SDK is substituted.** The real `CopilotConnectorSession` sits between
 * the connector and the faked SDK, and that placement is the point: the session's
 * own `abort()`/`destroy()` used to eat the SDK's rejection and return normally, so
 * an arm that stubbed the session out could watch the reporting side work while the
 * connector still reported `detached` over a session nobody proved was destroyed.
 * Here the rejection starts where a real one does.
 */
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageHandle } from '@makaio/ai-adapters-core';

/** Which release stage the test makes fail, and how often each one ran. */
const sdkStub = vi.hoisted(() => {
  const state = {
    failing: undefined as string | undefined,
    ran: [] as string[],
  };

  /**
   * Build one release stage that records itself and rejects when selected.
   * @param stage - Stage name recorded and matched against the failure choice.
   * @returns The stage callback.
   */
  const stage = (stage: string) => async (): Promise<void> => {
    state.ran.push(stage);
    if (state.failing === stage) throw new Error(`${stage} rejected`);
  };

  return { state, stage };
});

vi.mock('@github/copilot-sdk', () => {
  class CopilotClient {
    public constructor() {
      Object.assign(this, {
        start: async () => undefined,
        stop: sdkStub.stage('client stop'),
        createSession: async () => ({
          sessionId: 'copilot-session-1',
          // Registers the connector's event listener; nothing fires in a teardown test.
          on: () => undefined,
          send: sdkStub.stage('session send'),
          abort: sdkStub.stage('session abort'),
          destroy: sdkStub.stage('session destroy'),
        }),
      });
    }
  }

  return { CopilotClient };
});

import { GitHubCopilotConnector } from '../connector.js';
import { GitHubCopilotConnectorNamespace, GitHubCopilotConnectorSubjects } from '../namespaces/index.js';

/**
 * Build a connector over the faked SDK and publish its session.
 * @param onMessageSent - Optional observer for the announced message handle
 * @returns The initialized connector.
 */
async function makeConnector(onMessageSent?: (handle: MessageHandle) => void): Promise<GitHubCopilotConnector> {
  const connector = new GitHubCopilotConnector({
    bus: await GitHubCopilotConnectorNamespace.scopedBus(),
    adapterId: 'adapter-1',
    adapterName: 'github-copilot-sdk',
    agentId: 'agent-1',
    model: 'gpt-5',
    cwd: os.tmpdir(),
    env: {},
    adapterAuth: {
      processEnv: {},
      connectorDeliveries: [{ target: 'github-copilot-sdk.constructor', values: { githubToken: 'test-token' } }],
      configInheritance: 'empty',
    },
    onMessageSent,
  });
  await connector.initialize();
  return connector;
}

/** The three stages a close runs, in the order it runs them. */
const ALL_STAGES = ['session abort', 'session destroy', 'client stop'];

describe('GitHubCopilotConnector teardown evidence', () => {
  beforeEach(() => {
    sdkStub.state.failing = undefined;
    sdkStub.state.ran = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports `detached` when every release stage was accounted for', async () => {
    const connector = await makeConnector();

    const report = await connector.close();

    expect(sdkStub.state.ran).toEqual(ALL_STAGES);
    expect(report.evidence).toBe('detached');
  });

  it.each(ALL_STAGES)('claims no observed class when the %s stage failed unaccounted for', async (failing) => {
    sdkStub.state.failing = failing;
    const connector = await makeConnector();

    const report = await connector.close();

    // Every stage still ran — a failure must not skip the releases behind it —
    // and the class is the honest report of the one that went unaccounted for.
    expect(sdkStub.state.ran).toEqual(ALL_STAGES);
    expect(report.evidence).toBe('unknown');
    expect(report.detail).toContain(failing);
  });

  it('keeps an interrupt successful when the SDK refuses the abort', async () => {
    // The session propagates so a *teardown* can account for the stage; an
    // interrupt has no class to report and nothing an SDK refusal would change.
    sdkStub.state.failing = 'session abort';
    const connector = await makeConnector();

    await expect(connector.interrupt()).resolves.toBeUndefined();
    expect(sdkStub.state.ran).toEqual(['session abort']);
  });

  it('completes a dequeued handle when close wins during turn-start publication', async () => {
    let sentHandle: MessageHandle | undefined;
    const connector = await makeConnector((handle) => {
      sentHandle = handle;
    });
    const bus = await GitHubCopilotConnectorNamespace.scopedBus();
    let releaseTurnStart: (() => void) | undefined;
    const turnStartEntered = new Promise<void>((resolve) => {
      bus.on(GitHubCopilotConnectorSubjects.turn.turn_started, async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseTurnStart = release;
        });
      });
    });

    const sending = connector.sendMessage({
      role: 'user',
      message: 'race terminal close',
      blocks: [{ type: 'text', content: 'race terminal close' }],
    });
    await turnStartEntered;
    const closing = connector.close();
    if (!releaseTurnStart) {
      throw new Error('turn-start gate was not installed');
    }
    releaseTurnStart();

    await sending;
    if (!sentHandle) {
      throw new Error('sendMessage did not announce its message handle');
    }
    await expect(sentHandle.waitForCompletion()).resolves.toMatchObject({
      outcome: 'error',
      error: expect.objectContaining({ message: 'Session closed before queued message could be processed' }),
    });
    await closing;

    expect(sdkStub.state.ran).not.toContain('session send');
  });
});
