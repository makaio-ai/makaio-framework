import { describe, expect, it } from 'bun:test';
import type { ChatCompletionTool } from 'openai/resources/index.js';
import { OpenAIConnectorSession } from '../session.js';
import type { OpenAISessionConfig } from '../types/index.js';

function createOpenAITool(name: string): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name,
      description: `Description for ${name}`,
      parameters: { type: 'object', properties: {} },
    },
  };
}

/** Thin subclass that exposes the protected `getEffectiveToolNames` for assertions. */
class TestOpenAIConnectorSession extends OpenAIConnectorSession {
  public constructor(config: OpenAISessionConfig) {
    super(config);
  }

  public override getEffectiveToolNames(): string[] {
    return super.getEffectiveToolNames();
  }
}

describe('OpenAIConnectorSession tool refresh', () => {
  it('rebuilds the live tool set from the latest native tools after refresh', () => {
    const session = new TestOpenAIConnectorSession({
      bus: {} as never,
      adapterId: 'adapter-id',
      adapterName: 'openai-node',
      agentId: 'agent-id',
      cwd: '/tmp',
      model: 'gpt-4.1',
      env: {},
      client: {} as never,
      openAITools: [createOpenAITool('native_before')],
      emitSdkEvent: async () => {},
      handleError: () => {},
      requestToolApproval: async () => ({ action: 'allow' }),
    });

    session.replaceNativeTools([createOpenAITool('native_after')]);
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
