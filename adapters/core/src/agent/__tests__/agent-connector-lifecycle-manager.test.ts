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
        getConnectorRuntime: () => ({ connector: {} }) as never,
        setConnectorRuntime: () => {},
        getRuntimeSystemPrompt: () => undefined,
        setLastKnownAdapterSessionId: () => {},
        reportCleanupFailure: () => {},
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

  it('removes replacement wiring when initialization rolls back', async () => {
    const replacementUnsubscribe = vi.fn();
    const replacementClose = vi.fn(async () => {});
    const previousConnector = {
      cwd: '/workspace',
      model: 'model-a',
      getProcessingState: () => 'idle',
    };
    const replacementConnector = {
      onProcessingStateChanged: () => replacementUnsubscribe,
      initialize: async () => {
        throw new Error('replacement initialization failed');
      },
      close: replacementClose,
    };
    const manager = new AgentConnectorLifecycleManager({
      agentId: 'agent-test',
      buildConfigInput: () => ({}) as never,
      configFactory: async () => ({ adapterId: 'adapter-test' }) as never,
      connectorFactory: async () => replacementConnector as never,
      createOnMessageSent: () => () => {},
      wireEvents: async () => {},
      emitIdle: async () => {},
      getConnectorRuntime: () => ({ connector: previousConnector }) as never,
      setConnectorRuntime: () => {},
      getRuntimeSystemPrompt: () => undefined,
      setLastKnownAdapterSessionId: () => {},
      reportCleanupFailure: () => {},
    });

    await expect(manager.swapConnector()).rejects.toThrow('replacement initialization failed');

    expect(replacementUnsubscribe).toHaveBeenCalledOnce();
    expect(replacementClose).toHaveBeenCalledOnce();
  });
});
