import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { AgentNamespace, AgentSubjects } from '@makaio/contracts';
import { StepTelemetryCollector } from '../step-telemetry-collector.js';

describe('StepTelemetryCollector', () => {
  let bus: IMakaioBus;

  beforeEach(() => {
    bus = createBusInstance();
    bus.registerNamespace(AgentNamespace);
  });

  afterEach(() => {
    bus.disconnect();
  });

  it('accumulates token usage from usage events', async () => {
    const collector = new StepTelemetryCollector(bus);

    await bus.emit(AgentSubjects.usage, {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'test',
      adapterSessionId: 'session-1',
      provider: 'test-provider',
      model: 'test-model',
      inputTokens: 100,
      inputCachedTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
      totalTokens: 150,
      costUnits: 1,
      costUnitType: 'tokens',
    });

    await bus.emit(AgentSubjects.usage, {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'test',
      adapterSessionId: 'session-1',
      provider: 'test-provider',
      model: 'test-model',
      inputTokens: 200,
      inputCachedTokens: 20,
      outputTokens: 80,
      reasoningTokens: 0,
      totalTokens: 280,
      costUnits: 1,
      costUnitType: 'tokens',
    });

    const telemetry = collector.collect();

    expect(telemetry.tokenUsage.input).toBe(300);
    expect(telemetry.tokenUsage.output).toBe(130);
    expect(telemetry.tokenUsage.cached).toBe(30);

    collector.dispose();
  });

  it('counts tool use events', async () => {
    const collector = new StepTelemetryCollector(bus);

    await bus.emit(AgentSubjects.tool.use, {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'test',
      adapterSessionId: 'session-1',
      toolName: 'read_file',
      toolCallId: 'call-1',
    });

    await bus.emit(AgentSubjects.tool.use, {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'test',
      adapterSessionId: 'session-1',
      toolName: 'write_file',
      toolCallId: 'call-2',
    });

    await bus.emit(AgentSubjects.tool.use, {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'test',
      adapterSessionId: 'session-1',
      toolName: 'bash',
      toolCallId: 'call-3',
    });

    const telemetry = collector.collect();

    expect(telemetry.toolCalls).toBe(3);

    collector.dispose();
  });

  it('returns zero values when no events have been emitted', () => {
    const collector = new StepTelemetryCollector(bus);

    const telemetry = collector.collect();

    expect(telemetry.tokenUsage.input).toBe(0);
    expect(telemetry.tokenUsage.output).toBe(0);
    expect(telemetry.tokenUsage.cached).toBe(0);
    expect(telemetry.toolCalls).toBe(0);

    collector.dispose();
  });

  it('stops accumulating after dispose', async () => {
    const collector = new StepTelemetryCollector(bus);

    await bus.emit(AgentSubjects.usage, {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'test',
      adapterSessionId: 'session-1',
      provider: 'test-provider',
      model: 'test-model',
      inputTokens: 100,
      inputCachedTokens: 0,
      outputTokens: 50,
      reasoningTokens: 0,
      totalTokens: 150,
      costUnits: 1,
      costUnitType: 'tokens',
    });

    collector.dispose();

    // Events after dispose should not be counted
    await bus.emit(AgentSubjects.usage, {
      agentId: 'agent-1',
      adapterId: 'adapter-1',
      adapterName: 'test',
      adapterSessionId: 'session-1',
      provider: 'test-provider',
      model: 'test-model',
      inputTokens: 999,
      inputCachedTokens: 0,
      outputTokens: 999,
      reasoningTokens: 0,
      totalTokens: 1998,
      costUnits: 1,
      costUnitType: 'tokens',
    });

    const telemetry = collector.collect();

    expect(telemetry.tokenUsage.input).toBe(100);
    expect(telemetry.tokenUsage.output).toBe(50);
  });
});
