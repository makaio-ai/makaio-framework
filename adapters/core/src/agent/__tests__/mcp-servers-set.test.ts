import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import type { McpSessionContext } from '@makaio/contracts';
import {
  createAgentTestLifecycle,
  createTestableAgent,
  registerSuccessfulRuntimeMutationPersistence,
} from './helpers/mock-agent.js';
import { createNoAuthTestProviderContext } from '../../testing/index.js';

const TEST_AGENT_ID = 'test-agent-mcp';
const TEST_PROVIDER_CONTEXT = createNoAuthTestProviderContext('test-config', 'test');

const createMcpContext = (sessionId: string, serverName: string): McpSessionContext => ({
  sessionId,
  projectId: null,
  profileId: null,
  servers: [
    {
      name: serverName,
      transport: { type: 'http', url: `https://${serverName}.example.test/mcp` },
      exposureMode: 'direct',
    },
  ],
  directTools: [],
  discoverableTools: [],
});

describe('AIAgent MCP server replacement handler', () => {
  const ctx = createAgentTestLifecycle();
  let persistenceCleanup: () => void;

  beforeEach(() => {
    ctx.reset();
    persistenceCleanup = registerSuccessfulRuntimeMutationPersistence();
  });
  afterEach(async () => {
    persistenceCleanup();
    await ctx.teardown();
  });

  it('mcp.servers.set swaps the idle connector with the replacement MCP session context', async () => {
    const initialContext = createMcpContext('session-mcp-1', 'old-server');
    const replacementContext = createMcpContext('session-mcp-1', 'new-server');
    ctx.agent = createTestableAgent({
      agentId: TEST_AGENT_ID,
      sessionId: 'session-mcp-1',
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
      providerContext: TEST_PROVIDER_CONTEXT,
      mcpSessionContext: initialContext,
    });
    await ctx.agent.init();
    const initialConnector = ctx.createdConnectors[0]!;

    const response = await MakaioBus.request(AgentSubjects.mcp.servers.set, {
      agentId: TEST_AGENT_ID,
      adapterId: 'test-adapter',
      adapterName: 'test',
      adapterSessionId: 'test-session-id',
      mcpSessionContext: replacementContext,
    });

    expect(response).toEqual({ success: true, swapped: true });
    expect(ctx.createdConnectors).toHaveLength(2);
    expect(initialConnector.closeCalled).toBe(true);
    expect(ctx.agent.currentConnector.mcpSessionContext).toEqual(replacementContext);

    await MakaioBus.request(AgentSubjects.sendMessage, {
      agentId: TEST_AGENT_ID,
      adapterId: 'test-adapter',
      message: 'post-replacement turn',
    });

    expect(initialConnector.sentMessages).toHaveLength(0);
    expect(ctx.agent.currentConnector.sentMessages).toHaveLength(1);
  });

  it('mcp.servers.set can stage the latest active-turn request for the next dispatch', async () => {
    const initialContext = createMcpContext('session-mcp-2', 'old-server');
    const firstReplacement = createMcpContext('session-mcp-2', 'first-new-server');
    const latestReplacement = createMcpContext('session-mcp-2', 'latest-new-server');
    ctx.agent = createTestableAgent({
      agentId: TEST_AGENT_ID,
      sessionId: 'session-mcp-2',
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
      providerContext: TEST_PROVIDER_CONTEXT,
      mcpSessionContext: initialContext,
    });
    await ctx.agent.init();
    const initialConnector = ctx.createdConnectors[0]!;
    initialConnector.setProcessingState('processing_started');

    const firstResponse = await MakaioBus.request(AgentSubjects.mcp.servers.set, {
      agentId: TEST_AGENT_ID,
      adapterId: 'test-adapter',
      adapterName: 'test',
      adapterSessionId: 'test-session-id',
      mcpSessionContext: firstReplacement,
      turnActiveBehavior: 'stageForNextTurn',
    });
    const latestResponse = await MakaioBus.request(AgentSubjects.mcp.servers.set, {
      agentId: TEST_AGENT_ID,
      adapterId: 'test-adapter',
      adapterName: 'test',
      adapterSessionId: 'test-session-id',
      mcpSessionContext: latestReplacement,
      turnActiveBehavior: 'stageForNextTurn',
    });

    expect(firstResponse).toEqual({ success: true, swapped: false, staged: true });
    expect(latestResponse).toEqual({ success: true, swapped: false, staged: true });
    expect(ctx.createdConnectors).toHaveLength(1);

    initialConnector.setProcessingState('idle');
    await MakaioBus.request(AgentSubjects.sendMessage, {
      agentId: TEST_AGENT_ID,
      adapterId: 'test-adapter',
      message: 'next turn',
    });

    expect(ctx.createdConnectors).toHaveLength(2);
    expect(initialConnector.closeCalled).toBe(true);
    expect(ctx.agent.currentConnector.mcpSessionContext).toEqual(latestReplacement);
    expect(initialConnector.sentMessages).toHaveLength(0);
    expect(ctx.agent.currentConnector.sentMessages).toHaveLength(1);
  });

  it('applies staged model and MCP swaps inside one turn lock without reentrant deadlock', async () => {
    const initialContext = createMcpContext('session-mcp-3', 'old-server');
    const replacementContext = createMcpContext('session-mcp-3', 'new-server');
    ctx.agent = createTestableAgent({
      agentId: TEST_AGENT_ID,
      sessionId: 'session-mcp-3',
      mockConnectorFactory: ctx.mockFactory,
      initialModel: 'test-model-1',
      initialCwd: '/test/cwd',
      providerContext: TEST_PROVIDER_CONTEXT,
      mcpSessionContext: initialContext,
    });
    await ctx.agent.init();
    const initialConnector = ctx.createdConnectors[0]!;
    initialConnector.setProcessingState('processing_started');

    await expect(
      MakaioBus.request(AgentSubjects.model.change, {
        agentId: TEST_AGENT_ID,
        adapterId: 'test-adapter',
        adapterName: 'test',
        adapterSessionId: 'test-session-id',
        newModel: 'test-model-2',
        providerContext: TEST_PROVIDER_CONTEXT,
        turnActiveBehavior: 'stageForNextTurn',
        skipWarning: true,
      }),
    ).resolves.toMatchObject({ success: true, staged: true });
    await expect(
      MakaioBus.request(AgentSubjects.mcp.servers.set, {
        agentId: TEST_AGENT_ID,
        adapterId: 'test-adapter',
        adapterName: 'test',
        adapterSessionId: 'test-session-id',
        mcpSessionContext: replacementContext,
        turnActiveBehavior: 'stageForNextTurn',
      }),
    ).resolves.toMatchObject({ success: true, staged: true });

    initialConnector.setProcessingState('idle');
    await expect(
      MakaioBus.request(AgentSubjects.sendMessage, {
        agentId: TEST_AGENT_ID,
        adapterId: 'test-adapter',
        message: 'dispatch after both staged swaps',
      }),
    ).resolves.toMatchObject({ messageId: expect.any(String) });

    expect(ctx.createdConnectors).toHaveLength(3);
    expect(ctx.createdConnectors[0]?.closeCalled).toBe(true);
    expect(ctx.createdConnectors[1]?.closeCalled).toBe(true);
    expect(ctx.agent.currentConnector.model).toBe('test-model-2');
    expect(ctx.agent.currentConnector.mcpSessionContext).toEqual(replacementContext);
    expect(ctx.agent.currentConnector.sentMessages).toHaveLength(1);
  });
});
