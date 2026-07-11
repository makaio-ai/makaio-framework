import os from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { ToolSubjects } from '@makaio/contracts';
import { AnthropicSdkConnector } from '../connector.js';
import { AnthropicSdkConnectorNamespace } from '../namespaces/index.js';

class TestAnthropicSdkConnector extends AnthropicSdkConnector {
  /**
   * Create the real session and expose only its tool-execution environment.
   * @returns Environment forwarded by the session to tool bus requests
   */
  public async createToolContextEnv(): Promise<Record<string, string>> {
    await this.fetchTools();
    const session = this.createSession();
    const config = Reflect.get(session, 'config') as { env: Record<string, string> };
    return config.env;
  }
}

describe('AnthropicSdkConnector context environment', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    MakaioBus.on(ToolSubjects.list, (ctx) => {
      ctx.setResult({ tools: [], toolsets: [] });
    });
  });

  it('keeps connector authentication out of tool execution contexts', async () => {
    const connector = new TestAnthropicSdkConnector({
      bus: await AnthropicSdkConnectorNamespace.scopedBus(),
      globalBus: MakaioBus,
      adapterId: 'adapter-anthropic-context',
      adapterName: 'anthropic-sdk',
      agentId: 'agent-anthropic-context',
      model: 'claude-sonnet-4-20250514',
      cwd: os.tmpdir(),
      env: {
        ANTHROPIC_API_KEY: 'selected-process-secret',
        ANTHROPIC_AUTH_TOKEN: 'opposing-process-secret',
      },
      contextEnv: { PATH: '/usr/bin', CONFIG_HOME: '/isolated/anthropic' },
      adapterAuth: {
        processEnv: {},
        connectorDeliveries: [
          {
            target: 'anthropic-sdk.constructor',
            values: { apiKey: 'selected-constructor-secret', authToken: null },
          },
        ],
        configInheritance: 'empty',
      },
      providerConfig: {},
    });

    const env = await connector.createToolContextEnv();

    expect(env).toEqual({ PATH: '/usr/bin', CONFIG_HOME: '/isolated/anthropic' });
    expect(JSON.stringify(env)).not.toContain('secret');
  });
});
