import { describe, expect, it } from 'vitest';
import type { Tool } from '@anthropic-ai/sdk/resources/messages/messages.js';
import { createTestBusInstance } from '@makaio/test-utils';
import { AnthropicSdkSession } from '../session.js';
import { AnthropicSdkConnectorNamespace } from '../namespaces/index.js';

function createAnthropicTool(name: string): Tool {
  return {
    name,
    description: `Description for ${name}`,
    input_schema: { type: 'object', properties: {} },
  };
}

/** Thin subclass that exposes the protected `getEffectiveToolNames` for assertions. */
class TestAnthropicSdkSession extends AnthropicSdkSession {
  public override getEffectiveToolNames(): string[] {
    return super.getEffectiveToolNames();
  }
}

describe('AnthropicSdkSession tool refresh', () => {
  it('rebuilds the live tool set from the latest native tools after refresh', async () => {
    const globalBus = createTestBusInstance();
    globalBus.registerNamespaces([AnthropicSdkConnectorNamespace.definition]);
    const session = new TestAnthropicSdkSession({
      bus: await AnthropicSdkConnectorNamespace.scopedBus(globalBus),
      globalBus,
      adapterId: 'adapter-id',
      adapterName: 'anthropic-sdk',
      agentId: 'agent-id',
      cwd: '/tmp',
      model: 'claude-sonnet',
      env: {},
      client: {} as never,
      anthropicTools: [createAnthropicTool('native_before')],
      emitSdkEvent: async () => {},
      handleError: () => {},
      requestToolApproval: async () => ({ action: 'allow' }),
    });

    session.replaceNativeTools([createAnthropicTool('native_after')]);
    session.updateTools([
      {
        name: 'github__create_issue',
        description: 'Create issue',
        toolsetName: 'github',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);

    expect(session.getEffectiveToolNames()).toEqual(['native_after', 'github__create_issue']);
  });
});
