/// <reference types="bun-types" />
import { describe, it, expect, beforeEach, mock, spyOn, afterEach } from 'bun:test';
import { MakaioBus } from '@makaio/bus-core';
import { createMockScopedBus } from '@makaio/test-utils';
import { asAgentConnector, MockConnector } from './helpers/mock-agent.js';
import { AIAgent } from '../ai-agent.js';
import type { AIAgentConfig } from '../types.js';
import type { AIAgentConnector } from '../../connector/agent-connector.js';

/**
 * Extended test agent for swap-connector tests.
 * Tracks wireEvents calls and exposes swapConnector for direct testing.
 */
class SwapTestAgent extends AIAgent {
  public currentConnector!: MockConnector;
  public wireEventsCalls = 0;
  private mockConnectorFactory: (config: { model: string; cwd: string }) => MockConnector;

  /**
   * Create a swap test agent.
   * @param config - Agent configuration
   * @param mockConnectorFactory - Factory for creating mock connectors
   */
  public constructor(
    config: AIAgentConfig,
    mockConnectorFactory: (config: { model: string; cwd: string }) => MockConnector,
  ) {
    super(config);
    this.mockConnectorFactory = mockConnectorFactory;
  }

  /**
   * Expose swapConnector for testing.
   * @param configOverrides - Optional config overrides
   */
  public async testSwapConnector(configOverrides?: Partial<{ cwd: string; model: string }>): Promise<void> {
    await this.swapConnector(configOverrides);
  }

  /**
   * Required abstract implementation - tracks calls.
   * @param connector - The connector to wire events for
   */
  protected async wireEvents(connector: AIAgentConnector): Promise<void> {
    this.wireEventsCalls++;
    // @ts-expect-error -- the factory always produces MockConnector instances; narrowing is safe here
    this.currentConnector = connector;
  }
}

/**
 * Create a SwapTestAgent instance with factory support.
 * @param mockConnectorFactory - Factory function for creating mock connectors
 * @returns A configured SwapTestAgent
 */
function createSwapTestAgent(
  mockConnectorFactory: (config: { model: string; cwd: string }) => MockConnector,
): SwapTestAgent {
  const { bus: mockBus } = createMockScopedBus();

  const config: AIAgentConfig = {
    agentId: 'test-agent-swap',
    adapterId: 'test-adapter',
    adapterName: 'test',
    capabilities: [],
    nativeTools: [],
    adapterBus: mockBus,
    globalBus: MakaioBus,
    model: 'test-model-1',
    cwd: '/test/cwd1',
    configFactory: async (input) => ({
      bus: mockBus,
      agentId: 'test-agent-swap',
      adapterId: 'test-adapter',
      adapterName: 'test',
      model: input.model ?? 'test-model-1',
      cwd: input.cwd ?? '/test/cwd1',
    }),
    connectorFactory: async (factoryConfig) => {
      // MockConnector satisfies the runtime contract for all exercised methods
      return asAgentConnector(
        mockConnectorFactory({
          model: factoryConfig.model,
          cwd: factoryConfig.cwd,
        }),
      );
    },
  };

  return new SwapTestAgent(config, mockConnectorFactory);
}

describe('AIAgent.swapConnector', () => {
  let agent: SwapTestAgent;
  let createdConnectors: MockConnector[] = [];
  let cleanupFns: Array<() => void> = [];

  beforeEach(() => {
    createdConnectors = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanupFns) {
      cleanup();
    }
    cleanupFns = [];
    await agent?.close();
  });

  it('creates a new connector via factories', async () => {
    const mockFactory = mock((config: { model: string; cwd: string }) => {
      const connector = new MockConnector(config.model, config.cwd);
      createdConnectors.push(connector);
      return connector;
    });

    agent = createSwapTestAgent(mockFactory);
    await agent.init();

    expect(createdConnectors).toHaveLength(1);
    const initialConnector = createdConnectors[0];

    await agent.testSwapConnector({ model: 'test-model-2' });

    expect(createdConnectors).toHaveLength(2);
    expect(initialConnector.closeCalled).toBe(true);
    expect(agent.currentConnector.model).toBe('test-model-2');
    expect(agent.currentConnector.cwd).toBe('/test/cwd1');
  });

  it('rejects when connector is processing', async () => {
    const mockFactory = mock((config: { model: string; cwd: string }) => {
      const connector = new MockConnector(config.model, config.cwd);
      createdConnectors.push(connector);
      return connector;
    });

    agent = createSwapTestAgent(mockFactory);
    await agent.init();

    // Set connector to processing state
    agent.currentConnector.setProcessingState('processing_started');

    await expect(agent.testSwapConnector({ model: 'test-model-2' })).rejects.toThrow(
      /Cannot swap connector while processing/,
    );
  });

  it('preserves agent identity (agentId unchanged)', async () => {
    const mockFactory = mock((config: { model: string; cwd: string }) => {
      const connector = new MockConnector(config.model, config.cwd);
      createdConnectors.push(connector);
      return connector;
    });

    agent = createSwapTestAgent(mockFactory);
    await agent.init();

    const initialAgentId = agent.agentId;

    await agent.testSwapConnector({ cwd: '/test/cwd2' });

    expect(agent.agentId).toBe(initialAgentId);
  });

  it('calls wireEvents on new connector', async () => {
    const mockFactory = mock((config: { model: string; cwd: string }) => {
      const connector = new MockConnector(config.model, config.cwd);
      createdConnectors.push(connector);
      return connector;
    });

    agent = createSwapTestAgent(mockFactory);
    await agent.init();

    expect(agent.wireEventsCalls).toBe(1);

    await agent.testSwapConnector({ cwd: '/test/cwd2' });

    expect(agent.wireEventsCalls).toBe(2);
  });

  it('applies both cwd and model overrides', async () => {
    const mockFactory = mock((config: { model: string; cwd: string }) => {
      const connector = new MockConnector(config.model, config.cwd);
      createdConnectors.push(connector);
      return connector;
    });

    agent = createSwapTestAgent(mockFactory);
    await agent.init();

    await agent.testSwapConnector({ model: 'test-model-3', cwd: '/test/cwd3' });

    expect(agent.currentConnector.model).toBe('test-model-3');
    expect(agent.currentConnector.cwd).toBe('/test/cwd3');
  });

  it('preserves runtime overrides across sequential swaps (composability)', async () => {
    const mockFactory = mock((config: { model: string; cwd: string }) => {
      const connector = new MockConnector(config.model, config.cwd);
      createdConnectors.push(connector);
      return connector;
    });

    agent = createSwapTestAgent(mockFactory);
    await agent.init();

    // Initial state: model='test-model-1', cwd='/test/cwd1'
    expect(agent.currentConnector.model).toBe('test-model-1');
    expect(agent.currentConnector.cwd).toBe('/test/cwd1');

    // Swap 1: Change cwd only - model should be preserved
    await agent.testSwapConnector({ cwd: '/test/cwd2' });
    expect(agent.currentConnector.model).toBe('test-model-1');
    expect(agent.currentConnector.cwd).toBe('/test/cwd2');

    // Swap 2: Change model only - cwd should stay at '/test/cwd2', NOT reset to '/test/cwd1'
    await agent.testSwapConnector({ model: 'test-model-2' });
    expect(agent.currentConnector.model).toBe('test-model-2');
    expect(agent.currentConnector.cwd).toBe('/test/cwd2');

    // Verify both values were preserved through sequential swaps
    expect(agent.currentConnector.model).toBe('test-model-2');
    expect(agent.currentConnector.cwd).toBe('/test/cwd2');
  });

  it('keeps new connector active when old connector close fails', async () => {
    const mockFactory = mock((config: { model: string; cwd: string }) => {
      const connector = new MockConnector(config.model, config.cwd);
      createdConnectors.push(connector);
      return connector;
    });
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    agent = createSwapTestAgent(mockFactory);
    await agent.init();

    const initialConnector = createdConnectors[0];
    initialConnector.close = mock(async () => {
      throw new Error('close failed');
    });

    await expect(agent.testSwapConnector({ model: 'test-model-2' })).resolves.toBeUndefined();

    expect(agent.currentConnector.model).toBe('test-model-2');
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
