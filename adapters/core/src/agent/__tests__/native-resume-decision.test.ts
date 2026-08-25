import { describe, it, expect, beforeEach } from 'vitest';
import { createMockGlobalBus, createMockScopedBus } from '@makaio/test-utils';
import { AIAgent } from '../ai-agent.js';
import type { SessionContext } from '@makaio/contracts';
import type { AIAgentConfig } from '../types.js';
import { AgentTeardownArbiter } from '../agent-teardown-arbiter.js';

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
   * Expose protected supportsNativeFork for testing.
   * @returns Whether this agent supports native fork
   */
  public testSupportsNativeFork(): boolean {
    return this.supportsNativeFork();
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

class ForkCapableTestAgent extends TestAgent {
  protected override supportsNativeFork(): boolean {
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
    machineId: 'test-machine',
    ownerInstanceId: 'test-owner-instance',
    capabilities: [],
    nativeTools: [],
    adapterBus: mockBus,
    teardownArbiter: new AgentTeardownArbiter(),
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
        nativeLocality: { kind: 'native' },
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

  it('returns false when sessionContext does not confirm native locality', () => {
    expect(resumeCapableAgent.testShouldUseNativeResume({})).toBe(false);
  });

  it('returns false when native locality is degraded', () => {
    expect(
      resumeCapableAgent.testShouldUseNativeResume({
        nativeLocality: { kind: 'degrade', reason: 'missing-machine-id' },
      }),
    ).toBe(false);
  });

  it('returns false when native locality is foreign', () => {
    expect(
      resumeCapableAgent.testShouldUseNativeResume({
        nativeLocality: { kind: 'foreign', machineId: 'remote-machine' },
      }),
    ).toBe(false);
  });

  it('returns false when adapter does not support native resume', () => {
    expect(agent.testShouldUseNativeResume()).toBe(false);
  });
});

describe('AIAgent.supportsNativeFork', () => {
  let agent: TestAgent;
  let forkCapableAgent: ForkCapableTestAgent;

  beforeEach(() => {
    agent = createTestAgent();
    forkCapableAgent = createTestAgent(ForkCapableTestAgent) as ForkCapableTestAgent;
  });

  it('returns false by default on the base class', () => {
    expect(agent.testSupportsNativeFork()).toBe(false);
  });

  it('returns true when subclass overrides supportsNativeFork', () => {
    expect(forkCapableAgent.testSupportsNativeFork()).toBe(true);
  });

  it('does not re-derive fork capability from sessionContext signals', () => {
    // The fork decision belongs to the sessionContext.nativeFork directive
    // assembled by the orchestrator, not re-evaluated here.
    // supportsNativeFork() is a static capability declaration — it must
    // return the same value regardless of the runtime context.
    expect(forkCapableAgent.testSupportsNativeFork()).toBe(true);
    expect(agent.testSupportsNativeFork()).toBe(false);
  });
});
