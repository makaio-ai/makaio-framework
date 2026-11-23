import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpSubjects, type CallContext, type McpSessionContext } from '@makaio/contracts';
import { createTestBusInstance, createTestCall, makeStubExtensionBus } from '@makaio/test-utils';
import { createSessionAccountObservationRequester } from '../account-observation-requester.js';
import { ClaudeSdkConnector } from '../connector.js';
import {
  ClaudeCodeConnectorNamespace,
  ClaudeCodeConnectorSubjects,
  type ClaudeCodeConnectorBus,
} from '../namespace/index.js';
import { createIdleQueryMock } from './idle-query-mock.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => createIdleQueryMock()),
}));

const adapterName = 'claude-agent-sdk';
const adapterId = 'test-adapter';
const agentId = 'test-agent';
const carrier = { kind: 'makaio.extension', id: adapterName };
const principal = { kind: 'acme.person', id: 'mcp-operator' };
const mcpSessionContext: McpSessionContext = {
  sessionId: 'test-session',
  projectId: 'test-project',
  profileId: null,
  servers: [],
  directTools: [],
  discoverableTools: [],
};

describe('Claude SDK MCP session requests', () => {
  let carrierBus: ReturnType<typeof makeStubExtensionBus>;
  let scopedBus: ClaudeCodeConnectorBus;
  let connector: ClaudeSdkConnector;

  beforeEach(async () => {
    carrierBus = makeStubExtensionBus(createTestBusInstance(), adapterName);
    scopedBus = await ClaudeCodeConnectorNamespace.scopedBus(carrierBus);
    connector = new ClaudeSdkConnector({
      bus: scopedBus,
      globalBus: carrierBus,
      adapterId,
      adapterName,
      agentId,
      sessionId: mcpSessionContext.sessionId,
      model: 'claude-sonnet',
      cwd: '/tmp',
      env: {},
      clientId: 'claude-code',
      mcpSessionContext,
      requestSessionAccountObservation: createSessionAccountObservationRequester(carrierBus),
    });
  });

  afterEach(async () => {
    await connector.close(createTestCall());
  });

  it('registers with the adapter as caller and preserves the initiating principal', async () => {
    const calls: CallContext[] = [];
    carrierBus.on(McpSubjects.session.register, (ctx) => {
      calls.push(ctx.call);
      ctx.setResult({ port: 12345 });
    });

    await connector.initialize({ call: createTestCall({ principal }) });

    expect(calls).toEqual([expect.objectContaining({ caller: carrier, principal })]);
  });

  it('unregisters on teardown using the adapter carrier as caller and principal', async () => {
    const calls: CallContext[] = [];
    carrierBus.on(McpSubjects.session.unregister, (ctx) => {
      calls.push(ctx.call);
      ctx.setResult({});
    });

    await connector.initialize({ call: createTestCall({ principal }) });
    // ORIGIN: the carrier initiates connector shutdown.
    await connector.close(carrierBus.own('stop'));

    await expect.poll(() => calls).toEqual([expect.objectContaining({ caller: carrier, principal: carrier })]);
  });

  it('resolves MCP servers at the turn boundary with the adapter as caller', async () => {
    const calls: CallContext[] = [];
    carrierBus.on(McpSubjects.session.resolve, (ctx) => {
      calls.push(ctx.call);
      ctx.setResult(mcpSessionContext);
    });

    await connector.initialize({ call: createTestCall() });
    connector.markToolRefreshPending();
    await scopedBus.emit(createTestCall({ principal }), ClaudeCodeConnectorSubjects.turn.turn_finished, {
      adapterId,
      agentId,
      oldState: 'step_finished',
      newState: 'turn_finished',
      timestamp: Date.now(),
    });

    expect(calls).toEqual([expect.objectContaining({ caller: carrier, principal })]);
  });
});
