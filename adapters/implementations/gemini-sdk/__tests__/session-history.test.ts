import { describe, expect, it } from 'vitest';
import { createBusInstance } from '@makaio/bus-core';
import type { AgentToolApproveResponse } from '@makaio/contracts';
import { GeminiConnectorNamespace } from '../src/namespaces/index.js';
import { GeminiConnectorSession } from '../src/session.js';

describe('gemini-sdk session history rollback', () => {
  it('rolls history back to the captured length when retries follow a failed attempt', async () => {
    const bus = await GeminiConnectorNamespace.scopedBus();
    const globalBus = createBusInstance();
    let history = [{ role: 'user' }, { role: 'model' }, { role: 'user' }];
    const geminiChat = {
      getHistory: () => history,
      setHistory: (nextHistory: typeof history) => {
        history = nextHistory;
      },
    };

    const session = new GeminiConnectorSession({
      bus,
      globalBus,
      adapterId: 'adapter-test',
      adapterName: 'gemini-sdk',
      agentId: 'agent-test',
      cwd: process.cwd(),
      model: 'gemini-2.5-flash',
      env: {},
      geminiConfig: {
        getSessionId: () => 'session-test',
        getModel: () => 'gemini-2.5-flash',
      } as never,
      geminiChat: geminiChat as never,
      emitSdkEvent: async () => {},
      handleError: () => {},
      requestToolApproval: async () => ({ action: 'allow' }) as AgentToolApproveResponse,
    });

    const popLastHistoryEntry = Reflect.get(session, 'popLastHistoryEntry') as
      | ((previousLength: number) => void)
      | undefined;
    expect(popLastHistoryEntry).toBeTypeOf('function');

    popLastHistoryEntry?.call(session, 2);
    expect(history).toHaveLength(2);
  });

  it('does not remove history when a failed attempt never appended a new entry', async () => {
    const bus = await GeminiConnectorNamespace.scopedBus();
    const globalBus = createBusInstance();
    let history = [{ role: 'user' }, { role: 'model' }];
    const geminiChat = {
      getHistory: () => history,
      setHistory: (nextHistory: typeof history) => {
        history = nextHistory;
      },
    };

    const session = new GeminiConnectorSession({
      bus,
      globalBus,
      adapterId: 'adapter-test',
      adapterName: 'gemini-sdk',
      agentId: 'agent-test',
      cwd: process.cwd(),
      model: 'gemini-2.5-flash',
      env: {},
      geminiConfig: {
        getSessionId: () => 'session-test',
        getModel: () => 'gemini-2.5-flash',
      } as never,
      geminiChat: geminiChat as never,
      emitSdkEvent: async () => {},
      handleError: () => {},
      requestToolApproval: async () => ({ action: 'allow' }) as AgentToolApproveResponse,
    });

    const popLastHistoryEntry = Reflect.get(session, 'popLastHistoryEntry') as
      | ((previousLength: number) => void)
      | undefined;
    expect(popLastHistoryEntry).toBeTypeOf('function');

    popLastHistoryEntry?.call(session, history.length);
    expect(history).toHaveLength(2);
  });
});
