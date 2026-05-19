import os from 'node:os';
import { describe, expect, it, mock } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { clientDefinition as claudeClientDefinition } from '@makaio/client-claude-code';
import { ClaudeSdkConnector } from '../src/connector.js';
import { ClaudeCodeConnectorNamespace } from '../src/namespace/index.js';
import { ClaudeCodeAdapterName } from '../src/constants.js';
import { createSessionAccountObservationRequester } from '../src/account-observation-requester.js';

describe('ClaudeSdkConnector.changeReasoningInPlace()', () => {
  async function makeConnector(): Promise<ClaudeSdkConnector> {
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    return new ClaudeSdkConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: ClaudeCodeAdapterName,
      agentId: 'agent-test',
      model: 'claude-sonnet-4-20250514',
      cwd: os.tmpdir(),
      env: {},
      clientId: claudeClientDefinition.id,
      requestSessionAccountObservation: createSessionAccountObservationRequester(MakaioBus),
    });
  }

  it('returns true and calls setMaxThinkingTokens with the correct budget for an active level', async () => {
    const connector = await makeConnector();
    const mockSetMaxThinkingTokens = mock().mockResolvedValue(undefined);
    const mockSession = {
      getQueryInstance: () => ({ setMaxThinkingTokens: mockSetMaxThinkingTokens }),
      updateReasoningEffort: mock(),
    };
    Reflect.set(connector, 'session', mockSession);

    const result = await connector.changeReasoningInPlace('medium');

    expect(result).toBe(true);
    expect(mockSetMaxThinkingTokens).toHaveBeenCalledOnce();
    // 'medium' maps to 8000 tokens (claudeReasoningLevels.medium)
    expect(mockSetMaxThinkingTokens).toHaveBeenCalledWith(8000);
  });

  it('passes null to setMaxThinkingTokens when reasoning effort is "none"', async () => {
    const connector = await makeConnector();
    const mockSetMaxThinkingTokens = mock().mockResolvedValue(undefined);
    const mockSession = {
      getQueryInstance: () => ({ setMaxThinkingTokens: mockSetMaxThinkingTokens }),
      updateReasoningEffort: mock(),
    };
    Reflect.set(connector, 'session', mockSession);

    const result = await connector.changeReasoningInPlace('none');

    expect(result).toBe(true);
    expect(mockSetMaxThinkingTokens).toHaveBeenCalledWith(null);
  });

  it('returns false when no session exists (pre-start state)', async () => {
    const connector = await makeConnector();

    const result = await connector.changeReasoningInPlace('high');

    expect(result).toBe(false);
  });

  it('returns false when session exists but getQueryInstance() returns undefined', async () => {
    const connector = await makeConnector();
    const mockSession = { getQueryInstance: () => undefined };
    Reflect.set(connector, 'session', mockSession);

    const result = await connector.changeReasoningInPlace('high');

    expect(result).toBe(false);
  });

  it('returns false when setMaxThinkingTokens() throws (graceful fallback)', async () => {
    const connector = await makeConnector();
    const mockSetMaxThinkingTokens = mock().mockRejectedValue(new Error('SDK thinking switch failed'));
    const mockSession = {
      getQueryInstance: () => ({ setMaxThinkingTokens: mockSetMaxThinkingTokens }),
      updateReasoningEffort: mock(),
    };
    Reflect.set(connector, 'session', mockSession);

    const result = await connector.changeReasoningInPlace('high');

    expect(result).toBe(false);
    expect(mockSetMaxThinkingTokens).toHaveBeenCalledOnce();
  });

  it('does not mutate connector.currentReasoningEffort (mutation contract — caller is responsible)', async () => {
    const connector = await makeConnector();
    const mockSetMaxThinkingTokens = mock().mockResolvedValue(undefined);
    const mockSession = {
      getQueryInstance: () => ({ setMaxThinkingTokens: mockSetMaxThinkingTokens }),
      updateReasoningEffort: mock(),
    };
    Reflect.set(connector, 'session', mockSession);

    const initialEffort = connector.currentReasoningEffort;
    await connector.changeReasoningInPlace('high');

    expect(connector.currentReasoningEffort).toBe(initialEffort);
  });

  it('updates session config via updateReasoningEffort so query rotations use the new level', async () => {
    const connector = await makeConnector();
    const mockSetMaxThinkingTokens = mock().mockResolvedValue(undefined);
    const mockUpdateReasoningEffort = mock();
    const mockSession = {
      getQueryInstance: () => ({ setMaxThinkingTokens: mockSetMaxThinkingTokens }),
      updateReasoningEffort: mockUpdateReasoningEffort,
    };
    Reflect.set(connector, 'session', mockSession);

    await connector.changeReasoningInPlace('high');

    expect(mockUpdateReasoningEffort).toHaveBeenCalledOnce();
    expect(mockUpdateReasoningEffort).toHaveBeenCalledWith('high');
  });

  it('calls updateReasoningEffort with undefined when level is "none" (query rotation omits thinking)', async () => {
    const connector = await makeConnector();
    const mockSetMaxThinkingTokens = mock().mockResolvedValue(undefined);
    const mockUpdateReasoningEffort = mock();
    const mockSession = {
      getQueryInstance: () => ({ setMaxThinkingTokens: mockSetMaxThinkingTokens }),
      updateReasoningEffort: mockUpdateReasoningEffort,
    };
    Reflect.set(connector, 'session', mockSession);

    await connector.changeReasoningInPlace('none');

    expect(mockUpdateReasoningEffort).toHaveBeenCalledOnce();
    expect(mockUpdateReasoningEffort).toHaveBeenCalledWith(undefined);
  });

  it('does not call updateReasoningEffort when setMaxThinkingTokens throws', async () => {
    const connector = await makeConnector();
    const mockSetMaxThinkingTokens = mock().mockRejectedValue(new Error('SDK thinking switch failed'));
    const mockUpdateReasoningEffort = mock();
    const mockSession = {
      getQueryInstance: () => ({ setMaxThinkingTokens: mockSetMaxThinkingTokens }),
      updateReasoningEffort: mockUpdateReasoningEffort,
    };
    Reflect.set(connector, 'session', mockSession);

    const result = await connector.changeReasoningInPlace('high');

    expect(result).toBe(false);
    expect(mockUpdateReasoningEffort).not.toHaveBeenCalled();
  });

  it.each([
    ['low', 4000],
    ['medium', 8000],
    ['high', 16000],
    ['extra-high', 32000],
  ] as const)('applies correct token budget for reasoning level "%s"', async (level, expectedTokens) => {
    const connector = await makeConnector();
    const mockSetMaxThinkingTokens = mock().mockResolvedValue(undefined);
    const mockSession = {
      getQueryInstance: () => ({ setMaxThinkingTokens: mockSetMaxThinkingTokens }),
      updateReasoningEffort: mock(),
    };
    Reflect.set(connector, 'session', mockSession);

    await connector.changeReasoningInPlace(level);

    expect(mockSetMaxThinkingTokens).toHaveBeenCalledWith(expectedTokens);
  });
});
