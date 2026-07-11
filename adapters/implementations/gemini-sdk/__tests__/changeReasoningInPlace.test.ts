import os from 'node:os';
import { describe, it, expect } from 'vitest';
import { GeminiConnector } from '../src/connector.js';
import { GeminiConnectorNamespace } from '../src/namespaces/index.js';

describe('GeminiConnector.changeReasoningInPlace()', () => {
  it('returns false when no supportedReasoningLevels are declared', async () => {
    const bus = await GeminiConnectorNamespace.scopedBus();
    const connector = new GeminiConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'gemini-sdk',
      agentId: 'agent-test',
      model: 'gemini-2.5-flash',
      cwd: os.tmpdir(),
      env: {},
      // supportedReasoningLevels deliberately absent
    });

    const result = await connector.changeReasoningInPlace('medium');

    expect(result).toBe(false);
  });

  it('returns false when the requested level is not in supportedReasoningLevels', async () => {
    const bus = await GeminiConnectorNamespace.scopedBus();
    const connector = new GeminiConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'gemini-sdk',
      agentId: 'agent-test',
      model: 'gemini-2.5-flash',
      cwd: os.tmpdir(),
      env: {},
      supportedReasoningLevels: { low: 512, medium: 2048, high: 8192 },
    });

    const result = await connector.changeReasoningInPlace('none');

    expect(result).toBe(false);
  });

  it('returns true when the level is present in supportedReasoningLevels', async () => {
    const bus = await GeminiConnectorNamespace.scopedBus();
    const connector = new GeminiConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'gemini-sdk',
      agentId: 'agent-test',
      model: 'gemini-2.5-flash',
      cwd: os.tmpdir(),
      env: {},
      supportedReasoningLevels: { none: 0, low: 512, medium: 2048, high: 8192, 'extra-high': 16384 },
    });

    const result = await connector.changeReasoningInPlace('high');

    expect(result).toBe(true);
  });

  it('registers a thinking-config override for the current model on success', async () => {
    const bus = await GeminiConnectorNamespace.scopedBus();
    const connector = new GeminiConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'gemini-sdk',
      agentId: 'agent-test-thinking',
      model: 'gemini-2.5-flash',
      cwd: os.tmpdir(),
      env: {},
      supportedReasoningLevels: { none: 0, low: 512, medium: 2048, high: 8192, 'extra-high': 16384 },
    });

    await connector.changeReasoningInPlace('high');

    const geminiConfig = await connector.getModelMutationConfig();
    const resolved = geminiConfig.modelConfigService.getResolvedConfig({ model: 'gemini-2.5-flash' });
    const thinkingConfig = resolved.generateContentConfig?.thinkingConfig as
      | { thinkingBudget?: number; thinkingLevel?: string }
      | undefined;

    expect(thinkingConfig).toBeDefined();
    // Gemini 2.5 uses thinkingBudget; 3.x uses thinkingLevel — accept either.
    expect(thinkingConfig?.thinkingBudget === 8192 || thinkingConfig?.thinkingLevel === 'HIGH').toBe(true);
  });

  it('does NOT mutate currentReasoningEffort (mutation contract)', async () => {
    const bus = await GeminiConnectorNamespace.scopedBus();
    const connector = new GeminiConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'gemini-sdk',
      agentId: 'agent-test',
      model: 'gemini-2.5-flash',
      cwd: os.tmpdir(),
      env: {},
      supportedReasoningLevels: { medium: 2048 },
    });

    const effortBefore = connector.currentReasoningEffort;
    await connector.changeReasoningInPlace('medium');

    // The connector must not own this update — the caller (AgentRuntimeMutationManager) does.
    expect(connector.currentReasoningEffort).toBe(effortBefore);
  });

  it('changeModelInPlace uses currentReasoningEffort (not config.reasoningEffort) after in-place change', async () => {
    const bus = await GeminiConnectorNamespace.scopedBus();
    // Connector starts with reasoningEffort 'low' from config.
    const connector = new GeminiConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'gemini-sdk',
      agentId: 'agent-test-combined',
      model: 'gemini-2.5-flash',
      cwd: os.tmpdir(),
      env: {},
      reasoningEffort: 'low',
      supportedReasoningLevels: { low: 512, medium: 2048, high: 8192 },
    });

    // Simulate the caller (AgentRuntimeMutationManager) applying the reasoning change in-place
    // and then updating currentReasoningEffort itself (as per the mutation contract).
    await connector.changeReasoningInPlace('high');
    connector.currentReasoningEffort = 'high'; // Caller owns this mutation

    // Now change the model — it should propagate 'high', not the stale 'low' from config.
    const geminiConfig = await connector.getModelMutationConfig();
    await connector.changeModelInPlace('gemini-2.5-pro');

    const resolved = geminiConfig.modelConfigService.getResolvedConfig({ model: 'gemini-2.5-pro' });
    const thinkingConfig = resolved.generateContentConfig?.thinkingConfig as
      | { thinkingBudget?: number; thinkingLevel?: string }
      | undefined;

    expect(thinkingConfig).toBeDefined();
    expect(thinkingConfig?.thinkingBudget === 8192 || thinkingConfig?.thinkingLevel === 'HIGH').toBe(true);
  });
});
