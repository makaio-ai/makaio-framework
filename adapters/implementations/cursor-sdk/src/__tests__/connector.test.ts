import type { ProceduralConnectorSession } from '@makaio/ai-adapters-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CursorSdkProviderConfig } from '../schemas.js';

const sdkControls = vi.hoisted(() => ({
  createCalls: [] as Array<Record<string, unknown>>,
  failCreate: false,
}));

vi.mock('@cursor/sdk', () => ({
  Agent: {
    create: async (options: Record<string, unknown>) => {
      sdkControls.createCalls.push(options);
      if (sdkControls.failCreate) throw new Error('cursor init failed');
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
import { CursorSdkNamespace } from '../namespaces/index.js';

class TestCursorSdkConnector extends CursorSdkConnector {
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
 * @returns Test connector instance.
 */
async function createConnector(providerConfig?: CursorSdkProviderConfig): Promise<TestCursorSdkConnector> {
  return new TestCursorSdkConnector({
    bus: await CursorSdkNamespace.scopedBus(),
    adapterId: 'adapter-1',
    adapterName: 'cursor-sdk',
    agentId: 'agent-1',
    sessionId: 'session-1',
    model: 'composer-2',
    cwd: process.cwd(),
    env: { CURSOR_API_KEY: 'test-key' },
    providerConfig,
  });
}

describe('CursorSdkConnector', () => {
  beforeEach(() => {
    sdkControls.failCreate = false;
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
});
