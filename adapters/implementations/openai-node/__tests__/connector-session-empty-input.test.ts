import os from 'node:os';
import { describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { MessageHandle, normalizeMessageInput } from '@makaio/ai-adapters-core';
import type { AgentToolApproveResponse } from '@makaio/contracts';
import { createTestBusInstance, createTestCall } from '@makaio/test-utils';
import { OpenAIConnectorSession } from '../src/session.js';
import { OpenAINodeConnectorNamespace } from '../src/namespaces/index.js';

describe('OpenAIConnectorSession empty input guard', () => {
  it('rejects empty user content in buildMessages', async () => {
    const globalBus = createTestBusInstance();
    globalBus.registerNamespaces([OpenAINodeConnectorNamespace.definition]);
    const bus = await OpenAINodeConnectorNamespace.scopedBus(globalBus);
    const session = new OpenAIConnectorSession({
      bus,
      globalBus,
      adapterId: 'adapter-test',
      adapterName: 'openai-node',
      agentId: 'agent-test',
      sessionId: 'session-test',
      cwd: os.tmpdir(),
      model: 'gpt-4o-mini',
      env: {},
      client: new OpenAI({ apiKey: 'test-api-key' }),
      openAITools: [],
      supportsResponseFormatWithTools: true,
      supportsStructuredOutputStrict: true,
      emitSdkEvent: async () => {},
      handleError: () => {},
      requestToolApproval: async () => ({ action: 'allow' }) as AgentToolApproveResponse,
    });

    const buildMessages = Reflect.get(session, 'buildMessages') as ((handle: MessageHandle) => void) | undefined;
    expect(buildMessages).toBeTypeOf('function');

    const handle = new MessageHandle(createTestCall(), crypto.randomUUID(), normalizeMessageInput('   '), 'enqueue');
    expect(() => buildMessages?.call(session, handle)).toThrow(
      `[OpenAIConnectorSession] buildMessages produced empty user content (messageId=${handle.messageId})`,
    );
  });
});
