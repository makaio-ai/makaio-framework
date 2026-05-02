import { describe, expect, it, vi } from 'vitest';
import { AgentConnectorLifecycleManager } from '../agent-connector-lifecycle-manager.js';

describe('AgentConnectorLifecycleManager', () => {
  it('logs emitIdle failures from idle state transitions', async () => {
    let processingStateHandler: ((state: string) => void) | undefined;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const manager = new AgentConnectorLifecycleManager({
        agentId: 'agent-test',
        buildConfigInput: () => ({}) as never,
        configFactory: async () => ({ adapterId: 'adapter-test' }) as never,
        connectorFactory: async () => ({}) as never,
        createOnMessageSent: () => () => {},
        wireEvents: async () => {},
        emitIdle: async () => {
          throw new Error('emit idle failed');
        },
        getConnector: () => ({}) as never,
        setConnector: () => {},
        getRuntimeSystemPrompt: () => undefined,
        getRuntimeResponseSchema: () => undefined,
        setLastKnownAdapterSessionId: () => {},
      });

      const connector = {
        onProcessingStateChanged: (handler: (state: string) => void) => {
          processingStateHandler = handler;
          return () => {};
        },
      } as never;

      await manager.wireAllConnectorEvents(connector);
      processingStateHandler?.('idle');
      await new Promise((resolve) => setImmediate(resolve));

      expect(warnSpy).toHaveBeenCalledWith('[AIAgent] Failed to emit idle for agent agent-test:', expect.any(Error));
    } finally {
      warnSpy.mockRestore();
    }
  });
});
