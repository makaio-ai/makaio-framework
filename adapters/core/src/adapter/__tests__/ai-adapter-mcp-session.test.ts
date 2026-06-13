import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AdapterSubjects, type McpSessionContext } from '@makaio/contracts';
import type { ExtractSubjectPayload } from '@makaio/core';
import { createTestAdapter, MockConnector, type BaseAgentConnectorConfig, type TestBus } from './shared.js';

const TEST_PROVIDER_CONTEXT = { providerConfigId: 'test-config', definitionId: 'provider-1', credentialRefs: {} };

function createMcpSessionContext(): McpSessionContext {
  return {
    sessionId: 'session-mcp',
    projectId: null,
    profileId: 'profile-mcp',
    servers: [],
    directTools: [
      {
        fullName: 'github__create_issue',
        originalName: 'create_issue',
        serverName: 'github',
        description: 'Create an issue',
        inputSchema: { type: 'object', properties: {} },
        exposureMode: 'direct',
        enabled: true,
        exposed: true,
      },
    ],
    discoverableTools: [
      {
        fullName: 'github__list_repos',
        originalName: 'list_repos',
        serverName: 'github',
        description: 'List repositories',
        inputSchema: { type: 'object', properties: {} },
        exposureMode: 'discovery',
        enabled: true,
        exposed: true,
      },
    ],
  };
}

describe('AIAdapter MCP session wiring', () => {
  let adapter: ReturnType<typeof createTestAdapter>['adapter'];

  beforeEach(() => {
    MakaioBus.__resetHandlers?.();
  });

  afterEach(async () => {
    await adapter?.closeAsync();
  });

  it('creates and passes a session tool ledger when mcpSessionContext is present', async () => {
    const capturedConfigs: Array<BaseAgentConnectorConfig<TestBus> & { adapterId: string }> = [];
    const mcpSessionContext = createMcpSessionContext();

    ({ adapter } = createTestAdapter('test-adapter-mcp-session', {
      configFactory: async (input) => ({
        bus: input.bus,
        agentId: input.agentId,
        adapterId: input.adapterId,
        adapterName: input.adapterName,
        model: input.model ?? 'test-model',
        cwd: input.cwd ?? '/tmp',
        ...(input.mcpSessionContext !== undefined && { mcpSessionContext: input.mcpSessionContext }),
        ...(input.toolLedger !== undefined && { toolLedger: input.toolLedger }),
      }),
      connectorFactory: async (config) => {
        capturedConfigs.push(config);
        return new MockConnector(config);
      },
    }));

    await adapter.init();

    const result = await MakaioBus.request(AdapterSubjects.startAgent, {
      adapterId: adapter.adapterId,
      sessionId: 'session-mcp',
      role: 'lead',
      mcpSessionContext,
      providerContext: TEST_PROVIDER_CONTEXT,
    });

    expect(result.success).toBe(true);
    expect(capturedConfigs).toHaveLength(1);
    expect(capturedConfigs[0]?.mcpSessionContext).toEqual(mcpSessionContext);
    expect(capturedConfigs[0]?.toolLedger).toBeDefined();
    expect(capturedConfigs[0]?.toolLedger?.getAllEntries()).toEqual([]);
  });

  it('bridges startAgent adapterConfig into config factory providerConfig', async () => {
    const capturedInputs: Array<{ providerConfig?: Record<string, unknown> }> = [];

    ({ adapter } = createTestAdapter('test-adapter-config', {
      configFactory: async (input) => {
        capturedInputs.push({ providerConfig: input.providerConfig });
        return {
          bus: input.bus,
          agentId: input.agentId,
          adapterId: input.adapterId,
          adapterName: input.adapterName,
          model: input.model ?? 'test-model',
          cwd: input.cwd ?? '/tmp',
          ...(input.providerConfig !== undefined && { providerConfig: input.providerConfig }),
        };
      },
      connectorFactory: async (config) => new MockConnector(config),
    }));

    await adapter.init();

    const payload: ExtractSubjectPayload<typeof AdapterSubjects.startAgent> & {
      adapterConfig: Record<string, unknown>;
    } = {
      adapterId: adapter.adapterId,
      sessionId: 'session-adapter-config',
      role: 'lead',
      providerContext: TEST_PROVIDER_CONTEXT,
      adapterConfig: {
        queryOptions: {
          maxTurns: 2,
        },
      },
    };

    const result = await MakaioBus.request(AdapterSubjects.startAgent, payload);

    expect(result.success).toBe(true);
    expect(capturedInputs).toEqual([
      {
        providerConfig: {
          queryOptions: {
            maxTurns: 2,
          },
        },
      },
    ]);
  });
});
