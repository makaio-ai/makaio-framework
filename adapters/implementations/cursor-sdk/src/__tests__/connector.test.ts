import type { ProceduralConnectorSession, ProcessingState } from '@makaio/ai-adapters-core';
import { MakaioBus } from '@makaio/bus-core';
import { McpSubjects } from '@makaio/contracts';
import { createTestBusInstance } from '@makaio/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CursorSdkProviderConfig } from '../schemas.js';

const sdkControls = vi.hoisted(() => ({
  createCalls: [] as Array<Record<string, unknown>>,
  failCreate: false,
  createGate: undefined as Promise<void> | undefined,
}));

vi.mock('@cursor/sdk', () => ({
  Agent: {
    create: async (options: Record<string, unknown>) => {
      sdkControls.createCalls.push(options);
      if (sdkControls.failCreate) throw new Error('cursor init failed');
      await sdkControls.createGate;
      return {
        send: async () => ({
          id: 'run-1',
          wait: async () => ({ id: 'run-1', status: 'completed', result: 'ok' }),
          cancel: async () => undefined,
        }),
        [Symbol.asyncDispose]: async () => undefined,
      };
    },
  },
}));

import { CursorSdkConnector } from '../connector.js';
import { CursorSdkNamespace, CursorSdkSubjects } from '../namespaces/index.js';

class TestCursorSdkConnector extends CursorSdkConnector {
  /**
   * Expose processing updates so lifecycle tests can observe stale callbacks.
   * @param state - Processing state delivered by the turn handler
   */
  public override async updateProcessingState(state: ProcessingState): Promise<void> {
    await super.updateProcessingState(state);
  }

  /**
   * Expose the protected session getter for lifecycle assertions.
   * @returns Current connector session.
   */
  public currentSession(): ProceduralConnectorSession | undefined {
    return this.getSession();
  }
}

/**
 * Create a Cursor SDK connector configured for unit tests.
 * @param providerConfig - Optional Cursor SDK provider configuration.
 * @param hostBus - Host bus that owns the scoped adapter namespace
 * @returns Test connector instance.
 */
async function createConnector(
  providerConfig?: CursorSdkProviderConfig,
  hostBus = MakaioBus,
): Promise<TestCursorSdkConnector> {
  return new TestCursorSdkConnector({
    bus: await CursorSdkNamespace.scopedBus(hostBus.getContext()),
    globalBus: hostBus,
    adapterId: 'adapter-1',
    adapterName: 'cursor-sdk',
    agentId: 'agent-1',
    sessionId: 'session-1',
    model: 'composer-2',
    cwd: process.cwd(),
    env: { CURSOR_API_KEY: 'selected-secret', OPENAI_API_KEY: 'opposing-secret' },
    contextEnv: { PATH: '/usr/bin', CURSOR_CONFIG_DIR: '/isolated/cursor' },
    adapterAuth: {
      processEnv: {},
      connectorDeliveries: [{ target: 'cursor-sdk.agent-create', values: { apiKey: 'test-key' } }],
      configInheritance: 'empty',
    },
    providerConfig,
  });
}

describe('CursorSdkConnector', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    sdkControls.failCreate = false;
    sdkControls.createGate = undefined;
    sdkControls.createCalls.length = 0;
  });

  it('clears a failed lazy session so real session initialization can be retried', async () => {
    const connector = await createConnector();
    sdkControls.failCreate = true;

    await expect(connector.initialize()).rejects.toThrow('cursor init failed');
    expect(connector.currentSession()).toBeUndefined();

    sdkControls.failCreate = false;
    await connector.initialize();

    expect(connector.currentSession()).toBeDefined();
    expect(await connector.getAdapterSessionId()).toMatch(/^cursor-/);
    expect(sdkControls.createCalls).toHaveLength(2);
  });

  it('passes provider mode through lazy session initialization', async () => {
    const connector = await createConnector({ mode: 'plan' });

    await connector.initialize();

    expect(sdkControls.createCalls[0]).toMatchObject({ mode: 'plan' });
  });

  it('passes only the selected connector delivery to Agent.create', async () => {
    const connector = await createConnector();

    await connector.initialize();

    expect(sdkControls.createCalls[0]).toMatchObject({ apiKey: 'test-key' });
  });

  it('registers only the auth-free context environment with the MCP bridge', async () => {
    const registrations: unknown[] = [];
    MakaioBus.on(McpSubjects.session.register, (ctx) => {
      registrations.push(ctx.payload);
      ctx.setResult({ port: 4123 });
    });
    const connector = await createConnector();

    await connector.initialize();

    expect(registrations).toHaveLength(1);
    expect(registrations[0]).toMatchObject({
      contextOverrides: {
        env: { PATH: '/usr/bin', CURSOR_CONFIG_DIR: '/isolated/cursor' },
      },
    });
    expect(JSON.stringify(registrations[0])).not.toContain('selected-secret');
    expect(JSON.stringify(registrations[0])).not.toContain('opposing-secret');
  });

  it('removes all turn handlers on close so only a same-agent successor receives turn events', async () => {
    const hostBus = createTestBusInstance();
    const connector = await createConnector(undefined, hostBus);
    await connector.initialize();
    const closedUpdates = vi.spyOn(connector, 'updateProcessingState');

    await connector.close();

    const successor = await createConnector(undefined, hostBus);
    await successor.initialize();
    const successorUpdates = vi.spyOn(successor, 'updateProcessingState');
    const bus = await CursorSdkNamespace.scopedBus(hostBus.getContext());
    for (const [subject, oldState, newState] of [
      [CursorSdkSubjects.turn.turn_started, 'idle', 'turn_started'],
      [CursorSdkSubjects.turn.step_started, 'turn_started', 'step_started'],
      [CursorSdkSubjects.turn.step_finished, 'step_started', 'step_finished'],
      [CursorSdkSubjects.turn.turn_finished, 'step_finished', 'turn_finished'],
    ] as const) {
      await bus.emit(subject, {
        adapterId: 'adapter-1',
        agentId: 'agent-1',
        oldState,
        newState,
        timestamp: Date.now(),
      });
    }

    expect(connector.getProcessingState()).toBe('idle');
    expect(closedUpdates).not.toHaveBeenCalled();
    expect(successorUpdates).toHaveBeenCalled();
    await successor.close();
  });

  it('does not wire turn handlers when close wins while Agent.create is blocked', async () => {
    let releaseCreate: (() => void) | undefined;
    sdkControls.createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const hostBus = createTestBusInstance();
    const connector = await createConnector(undefined, hostBus);
    const initialization = connector.initialize();

    await vi.waitFor(() => expect(sdkControls.createCalls).toHaveLength(1));
    const closing = connector.close();
    releaseCreate?.();

    await expect(initialization).rejects.toThrow('closed connector');
    await closing;
    const updates = vi.spyOn(connector, 'updateProcessingState');
    await (await CursorSdkNamespace.scopedBus(hostBus.getContext())).emit(CursorSdkSubjects.turn.turn_started, {
      adapterId: 'adapter-1',
      agentId: 'agent-1',
      oldState: 'idle',
      newState: 'turn_started',
      timestamp: Date.now(),
    });
    expect(updates).not.toHaveBeenCalled();
  });
});
