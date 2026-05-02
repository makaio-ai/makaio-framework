import { describe, it, expect, beforeEach } from 'vitest';
import { createMockGlobalBus, createMockScopedBus } from '@makaio/test-utils';
import { AIAgent } from '../ai-agent.js';
import type { SessionContext } from '@makaio/contracts';
import type { AIAgentConfig } from '../types.js';

/**
 * Concrete test agent to access protected shouldUseNativeResume method.
 * Extends AIAgent with minimal stubs for abstract methods.
 */
class TestAgent extends AIAgent {
  /**
   * Expose protected shouldUseNativeResume for testing.
   * @param ctx - Session context signals from SessionOrchestrator
   */
  public testShouldUseNativeResume(ctx?: SessionContext): boolean {
    return this.shouldUseNativeResume(ctx);
  }

  /**
   * Required abstract implementation - returns minimal stub.
   */
  protected wireEvents(): void {
    // No-op for testing
  }
}

class ResumeCapableTestAgent extends TestAgent {
  protected override supportsNativeResume(): boolean {
    return true;
  }
}

/**
 * Create a TestAgent instance with minimal required config.
 * @param AgentCtor - Agent constructor used for capability overrides
 */
function createTestAgent(AgentCtor: typeof TestAgent = TestAgent): TestAgent {
  const { bus: mockBus } = createMockScopedBus();
  const { bus: mockGlobalBus } = createMockGlobalBus();

  const config: AIAgentConfig = {
    agentId: 'test-agent',
    adapterId: 'test-adapter',
    adapterName: 'test',
    capabilities: [],
    nativeTools: [],
    adapterBus: mockBus,
    globalBus: mockGlobalBus,
    configFactory: async () => ({
      bus: mockBus,
      agentId: 'test-agent',
      adapterId: 'test-adapter',
      adapterName: 'test',
      model: 'test-model',
      cwd: '/tmp',
    }),
    connectorFactory: () => ({}) as ReturnType<AIAgentConfig['connectorFactory']>,
  };

  return new AgentCtor(config);
}

describe('AIAgent.shouldUseNativeResume', () => {
  let agent: TestAgent;
  let resumeCapableAgent: ResumeCapableTestAgent;

  beforeEach(() => {
    agent = createTestAgent();
    resumeCapableAgent = createTestAgent(ResumeCapableTestAgent) as ResumeCapableTestAgent;
  });

  it('returns false when isFirstTurn is true', () => {
    expect(resumeCapableAgent.testShouldUseNativeResume({ isFirstTurn: true })).toBe(false);
  });

  it('returns false when hasCompression is true', () => {
    expect(resumeCapableAgent.testShouldUseNativeResume({ hasCompression: true })).toBe(false);
  });

  it('returns false when hasNewTransforms is true', () => {
    expect(resumeCapableAgent.testShouldUseNativeResume({ hasNewTransforms: true })).toBe(false);
  });

  it('returns false when hasConnectorSwap is true', () => {
    expect(resumeCapableAgent.testShouldUseNativeResume({ hasConnectorSwap: true })).toBe(false);
  });

  it('returns true when adapter supports native resume and no signals force fresh', () => {
    expect(
      resumeCapableAgent.testShouldUseNativeResume({
        isFirstTurn: false,
        hasCompression: false,
        hasNewTransforms: false,
      }),
    ).toBe(true);
  });

  it('returns false when multiple signals are true', () => {
    expect(
      resumeCapableAgent.testShouldUseNativeResume({
        isFirstTurn: true,
        hasCompression: true,
        hasNewTransforms: true,
      }),
    ).toBe(false);
  });

  it('returns true with empty object when adapter supports native resume', () => {
    expect(resumeCapableAgent.testShouldUseNativeResume({})).toBe(true);
  });

  it('returns false when adapter does not support native resume', () => {
    expect(agent.testShouldUseNativeResume()).toBe(false);
  });
});
