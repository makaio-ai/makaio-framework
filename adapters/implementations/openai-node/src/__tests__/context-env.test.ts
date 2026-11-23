import os from 'node:os';
import { beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { type CallContext, ToolSubjects } from '@makaio/contracts';
import { createTestCall } from '@makaio/test-utils';
import { OpenAINodeConnector } from '../connector.js';
import { OpenAINodeConnectorNamespace } from '../namespaces/index.js';

class TestOpenAINodeConnector extends OpenAINodeConnector {
  /**
   * Create the real session and expose only its tool-execution environment.
   * @param call - Call of the message initializing the session
   * @returns Environment forwarded by the session to tool bus requests
   */
  public async createToolContextEnv(call: CallContext): Promise<Record<string, string>> {
    await this.fetchTools(call);
    const session = this.createSession();
    const config = Reflect.get(session, 'config') as { env: Record<string, string> };
    return config.env;
  }
}

describe('OpenAINodeConnector context environment', () => {
  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
    MakaioBus.on(ToolSubjects.list, (ctx) => {
      ctx.setResult({ tools: [], toolsets: [] });
    });
  });

  it('keeps connector authentication out of tool execution contexts', async () => {
    const connector = new TestOpenAINodeConnector({
      bus: await OpenAINodeConnectorNamespace.scopedBus(MakaioBus),
      globalBus: MakaioBus,
      adapterId: 'adapter-openai-context',
      adapterName: 'openai-node',
      agentId: 'agent-openai-context',
      model: 'gpt-4o',
      cwd: os.tmpdir(),
      env: {
        OPENAI_API_KEY: 'selected-process-secret',
        OPENAI_ADMIN_KEY: 'opposing-process-secret',
      },
      contextEnv: { PATH: '/usr/bin', CONFIG_HOME: '/isolated/openai' },
      adapterAuth: {
        processEnv: {},
        connectorDeliveries: [
          {
            target: 'openai-node.constructor',
            values: { apiKey: 'selected-constructor-secret', adminAPIKey: null },
          },
        ],
        configInheritance: 'empty',
      },
      providerConfig: {},
    });

    const env = await connector.createToolContextEnv(createTestCall());

    expect(env).toEqual({ PATH: '/usr/bin', CONFIG_HOME: '/isolated/openai' });
    expect(JSON.stringify(env)).not.toContain('secret');
  });
});
