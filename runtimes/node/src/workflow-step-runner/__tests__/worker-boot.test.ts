import { describe, it, expect } from 'vitest';
import { AgentSubjects, McpSubjects } from '@makaio/contracts';
import { bootWorkerBus, bootWorkerRuntime } from '../worker-boot.js';
import { StepTelemetryCollector } from '../step-telemetry-collector.js';

describe('bootWorkerBus', () => {
  it('creates a bus instance without transport when busUrl is absent', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });

    expect(handle.bus).toBeDefined();
    expect(handle.bus.emit).toBeTypeOf('function');
    expect(handle.bus.on).toBeTypeOf('function');

    // close should not throw
    await handle.close();
  });

  it('registers framework contract namespaces (agent subjects available)', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });

    // Verify we can subscribe to agent subjects without error
    const unsubscribe = handle.bus.on(AgentSubjects.usage, () => {
      // no-op
    });
    unsubscribe();

    await handle.close();
  });

  it('integrates with StepTelemetryCollector on a local bus', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });
    const collector = new StepTelemetryCollector(handle.bus);

    await handle.bus.emit(AgentSubjects.usage, {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'test',
      adapterSessionId: 'session-1',
      provider: 'test-provider',
      model: 'test-model',
      inputTokens: 500,
      inputCachedTokens: 50,
      outputTokens: 200,
      reasoningTokens: 0,
      totalTokens: 700,
      costUnits: 1,
      costUnitType: 'tokens',
    });

    await handle.bus.emit(AgentSubjects.tool.use, {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'test',
      adapterSessionId: 'session-1',
      toolName: 'bash',
      toolCallId: 'call-1',
    });

    const telemetry = collector.collect();

    expect(telemetry.tokenUsage.input).toBe(500);
    expect(telemetry.tokenUsage.output).toBe(200);
    expect(telemetry.tokenUsage.cached).toBe(50);
    expect(telemetry.toolCalls).toBe(1);

    collector.dispose();
    await handle.close();
  });

  it('boots the worker-local MCP bridge as part of worker runtime', async () => {
    const handle = await bootWorkerBus({ busAuth: { kind: 'none' } });
    const runtime = await bootWorkerRuntime(handle, { toolsets: [], adapters: [] }, { cwd: process.cwd() });

    try {
      const registration = await handle.bus.request(McpSubjects.session.register, {
        adapterSessionId: 'worker-mcp-session',
        agentId: 'agent-1',
        adapterId: 'adapter-1',
        adapterName: 'test-adapter',
        sessionId: 'session-1',
        contextOverrides: {},
      });

      expect(registration.port).toBeGreaterThan(0);
    } finally {
      await runtime.close();
      await handle.close();
    }
  });
});
