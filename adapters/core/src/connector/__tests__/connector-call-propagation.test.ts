import { normalizeMessageInput } from '@makaio/ai-adapters-core';
import { type CallContext, type Party, ToolSubjects } from '@makaio/contracts';
import { createTestBusInstance, createTestCall } from '@makaio/test-utils';
import { describe, expect, it, vi } from 'vitest';
import {
  createMockTurn,
  MockJsonRpcClient,
} from '../../../../implementations/codex-app-server/src/__tests__/shared.js';
import { CodexAppServerConnector } from '../../../../implementations/codex-app-server/src/connector.js';
import { CodexAppServerNamespace } from '../../../../implementations/codex-app-server/src/namespaces/index.js';
import { OpenAINodeConnector } from '../../../../implementations/openai-node/src/connector.js';
import { OpenAINodeConnectorNamespace } from '../../../../implementations/openai-node/src/namespaces/index.js';

const calls = ['first-principal', 'second-principal'].map((id) =>
  createTestCall({ principal: { kind: 'makaio.job-run', id } }),
);

const message = normalizeMessageInput('Reply with a greeting');

interface ObservedSend {
  readonly event: string;
  readonly principal: Party;
}

/**
 * Assert that each expected send occurred with the principal of this turn.
 * @param sends - Recorded sends, drained before the next turn
 * @param call - Call of the message that started the turn
 * @param events - Expected event sequence
 */
function expectTurnSends(sends: ObservedSend[], call: CallContext, events: readonly string[]): void {
  expect(sends.splice(0), `sends for ${call.principal.id}`).toEqual(
    events.map((event) => ({ event, principal: call.principal })),
  );
}

/** Return a fresh streaming provider response for each turn. */
function openAIResponse(): Response {
  const chunk = { id: 'completion', object: 'chat.completion.chunk', created: 1, model: 'gpt-4o' };
  const chunks = [
    { ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] },
    { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
  return new Response(`${chunks.map((part) => `data: ${JSON.stringify(part)}\n\n`).join('')}data: [DONE]\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** Create an isolated bus with a registry responder returning no tools. */
function createConnectorBus() {
  const bus = createTestBusInstance();
  bus.on(ToolSubjects.list, (ctx) => ctx.setResult({ tools: [], toolsets: [] }));
  return bus;
}

describe('connector call propagation', () => {
  it('keeps each message principal through the stream connector and session', async () => {
    const globalBus = createConnectorBus();
    globalBus.registerNamespaces([OpenAINodeConnectorNamespace.definition]);
    const bus = await OpenAINodeConnectorNamespace.scopedBus(globalBus);
    const { sdk, turn } = OpenAINodeConnectorNamespace.subjects;
    const sends: ObservedSend[] = [];
    bus.on(sdk.event, (ctx) => {
      const { eventType } = ctx.payload.event;
      if (eventType === 'agent_started') sends.push({ event: eventType, principal: ctx.call.principal });
    });
    bus.on(turn.state_changed, (ctx) => {
      sends.push({ event: ctx.payload.newState, principal: ctx.call.principal });
    });

    const connector = new OpenAINodeConnector({
      bus,
      globalBus,
      adapterName: 'openai-node',
      agentId: 'stream-agent',
      model: 'gpt-4o',
      cwd: process.cwd(),
      env: {},
      providerConfig: { baseUrl: 'https://stream-provider.invalid/v1' },
      adapterAuth: {
        processEnv: {},
        configInheritance: 'empty',
        connectorDeliveries: [{ target: 'openai-node.constructor', values: { apiKey: 'test-key', adminAPIKey: null } }],
      },
    });

    vi.stubGlobal('fetch', async () => openAIResponse());
    try {
      for (const call of calls) {
        const handle = await connector.sendMessage(message, { call });
        await expect(handle.waitForCompletion()).resolves.toMatchObject({ outcome: 'completed' });
        await connector.complete();
        expectTurnSends(sends, call, [
          'agent_started',
          'turn_started',
          'step_started',
          'step_finished',
          'turn_finished',
        ]);
      }
    } finally {
      vi.unstubAllGlobals();
      await connector.close(createTestCall());
    }
  });

  it('keeps each message principal through Codex turn dispatch and completion', async () => {
    const globalBus = createConnectorBus();
    globalBus.registerNamespaces([CodexAppServerNamespace.definition]);
    const bus = await CodexAppServerNamespace.scopedBus(globalBus);
    const { turn_state_changed, agent_message } = CodexAppServerNamespace.subjects;
    const sends: ObservedSend[] = [];
    bus.on(turn_state_changed, (ctx) => {
      sends.push({ event: ctx.payload.newState, principal: ctx.call.principal });
    });
    bus.on(agent_message, (ctx) => {
      sends.push({ event: 'agent_message', principal: ctx.call.principal });
    });

    const jsonRpcClient = new MockJsonRpcClient();
    const connector = new CodexAppServerConnector({
      bus,
      globalBus,
      adapterId: 'codex-adapter',
      adapterName: 'codex-app-server',
      agentId: 'codex-agent',
      model: 'test-model',
      cwd: process.cwd(),
      env: {},
      clientId: 'codex',
      jsonRpcClient,
    });

    try {
      for (const call of calls) {
        const handle = await connector.sendMessage(message, { call });
        const threadId = await connector.getAdapterSessionId();
        const turnId = call.principal.id;
        const item = { id: `${turnId}-reply`, type: 'agentMessage', text: 'Hello' };
        await jsonRpcClient.receiveNotification('turn/started', { threadId, turn: createMockTurn({ id: turnId }) });
        await jsonRpcClient.receiveNotification('item/started', { threadId, turnId, item });
        await jsonRpcClient.receiveNotification('item/completed', { threadId, turnId, item });
        await jsonRpcClient.receiveNotification('turn/completed', {
          threadId,
          turn: { ...createMockTurn({ id: turnId, status: 'completed' }), items: [item] },
        });
        await expect(handle.waitForCompletion()).resolves.toMatchObject({ outcome: 'completed' });
        await connector.complete();
        expectTurnSends(sends, call, [
          'active',
          'processing_started',
          'turn_started',
          'step_started',
          'step_finished',
          'turn_finished',
          'agent_message',
        ]);
      }
    } finally {
      await connector.close();
    }
  });
});
