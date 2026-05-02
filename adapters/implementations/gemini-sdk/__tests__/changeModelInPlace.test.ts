import os from 'node:os';
import { describe, it, expect } from 'vitest';
import { GeminiConnector } from '../src/connector.js';
import { GeminiConnectorNamespace } from '../src/namespaces/index.js';

describe('GeminiConnector.changeModelInPlace()', () => {
  it('returns true — Gemini always supports in-place model change', async () => {
    const bus = await GeminiConnectorNamespace.scopedBus();
    const connector = new GeminiConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'gemini-sdk',
      agentId: 'agent-test',
      model: 'gemini-2.5-flash',
      cwd: os.tmpdir(),
      env: {},
    });

    const result = await connector.changeModelInPlace('gemini-2.5-pro');

    expect(result).toBe(true);
  });

  it('updates the mutable Gemini config model to the new model name', async () => {
    const bus = await GeminiConnectorNamespace.scopedBus();
    const connector = new GeminiConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'gemini-sdk',
      agentId: 'agent-test',
      model: 'gemini-2.5-flash',
      cwd: os.tmpdir(),
      env: {},
    });

    const geminiConfig = connector.getModelMutationConfig();
    expect(geminiConfig.getModel()).toBe('gemini-2.5-flash');

    await connector.changeModelInPlace('gemini-2.5-pro');

    expect(geminiConfig.getModel()).toBe('gemini-2.5-pro');
  });

  it('does NOT mutate connector.model (mutation contract)', async () => {
    const bus = await GeminiConnectorNamespace.scopedBus();
    const connector = new GeminiConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'gemini-sdk',
      agentId: 'agent-test',
      model: 'gemini-2.5-flash',
      cwd: os.tmpdir(),
      env: {},
    });

    const modelBefore = connector.model;
    await connector.changeModelInPlace('gemini-2.5-pro');

    expect(connector.model).toBe(modelBefore);
  });

  it('re-registers the reasoning override for the new model when reasoningEffort is set', async () => {
    const bus = await GeminiConnectorNamespace.scopedBus();
    const connector = new GeminiConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: 'gemini-sdk',
      agentId: 'agent-test-reasoning',
      model: 'gemini-2.5-flash',
      cwd: os.tmpdir(),
      env: {},
      reasoningEffort: 'medium',
    });

    const geminiConfig = connector.getModelMutationConfig();
    await connector.changeModelInPlace('gemini-2.5-pro');

    const resolved = geminiConfig.modelConfigService.getResolvedConfig({
      model: 'gemini-2.5-pro',
    });
    const thinkingConfig = resolved.generateContentConfig?.thinkingConfig as
      | { thinkingBudget?: number; thinkingLevel?: string }
      | undefined;

    expect(thinkingConfig).toBeDefined();
    // Gemini families differ: 2.5 uses thinkingBudget, newer models use thinkingLevel.
    expect(thinkingConfig?.thinkingBudget === 2048 || thinkingConfig?.thinkingLevel === 'MEDIUM').toBe(true);
  });
});
