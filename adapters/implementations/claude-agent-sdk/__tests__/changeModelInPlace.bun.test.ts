import os from 'node:os';
import { describe, expect, it, mock } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { clientDefinition as claudeClientDefinition } from '@makaio/client-claude-code';
import { ClaudeSdkConnector } from '../src/connector.js';
import { ClaudeCodeConnectorNamespace } from '../src/namespace/index.js';
import { ClaudeCodeAdapterName } from '../src/constants.js';
import { createSessionAccountObservationRequester } from '../src/account-observation-requester.js';

describe('ClaudeSdkConnector.changeModelInPlace()', () => {
  async function makeConnector(model = 'claude-sonnet-4-20250514'): Promise<ClaudeSdkConnector> {
    const bus = await ClaudeCodeConnectorNamespace.scopedBus();
    return new ClaudeSdkConnector({
      bus,
      adapterId: 'adapter-test',
      adapterName: ClaudeCodeAdapterName,
      agentId: 'agent-test',
      model,
      cwd: os.tmpdir(),
      env: {},
      clientId: claudeClientDefinition.id,
      requestSessionAccountObservation: createSessionAccountObservationRequester(MakaioBus),
    });
  }

  it('returns true and calls setModel when session has a query instance', async () => {
    const connector = await makeConnector();
    const mockSetModel = mock().mockResolvedValue(undefined);
    const mockSession = { getQueryInstance: () => ({ setModel: mockSetModel }) };
    Reflect.set(connector, 'session', mockSession);

    const result = await connector.changeModelInPlace('claude-opus-4-20250514');

    expect(result).toBe(true);
    expect(mockSetModel).toHaveBeenCalledOnce();
    expect(mockSetModel).toHaveBeenCalledWith('claude-opus-4-20250514');
  });

  it('returns false when no session exists (pre-start state)', async () => {
    const connector = await makeConnector();

    const result = await connector.changeModelInPlace('claude-opus-4-20250514');

    expect(result).toBe(false);
  });

  it('returns false when session exists but getQueryInstance() returns undefined', async () => {
    const connector = await makeConnector();
    const mockSession = { getQueryInstance: () => undefined };
    Reflect.set(connector, 'session', mockSession);

    const result = await connector.changeModelInPlace('claude-opus-4-20250514');

    expect(result).toBe(false);
  });

  it('returns false when setModel() throws (graceful fallback)', async () => {
    const connector = await makeConnector();
    const mockSetModel = mock().mockRejectedValue(new Error('SDK model switch failed'));
    const mockSession = { getQueryInstance: () => ({ setModel: mockSetModel }) };
    Reflect.set(connector, 'session', mockSession);

    const result = await connector.changeModelInPlace('claude-opus-4-20250514');

    expect(result).toBe(false);
    expect(mockSetModel).toHaveBeenCalledOnce();
  });

  it('does not mutate connector.model (mutation contract — caller is responsible)', async () => {
    const initialModel = 'claude-sonnet-4-20250514';
    const connector = await makeConnector(initialModel);
    const mockSetModel = mock().mockResolvedValue(undefined);
    const mockSession = { getQueryInstance: () => ({ setModel: mockSetModel }) };
    Reflect.set(connector, 'session', mockSession);

    await connector.changeModelInPlace('claude-opus-4-20250514');

    expect(connector.model).toBe(initialModel);
  });
});
