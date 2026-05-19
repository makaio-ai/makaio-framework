import { describe, expect, it } from 'bun:test';
import { createMockScopedBus } from '@makaio/test-utils';
import { MessageHandle } from '../../message-handle/index.js';
import { AIAgentConnector } from '../agent-connector.js';
import type { AgentStartResult, BaseAgentConnectorConfig, ConnectorStartOptions } from '../../agent/types.js';
import type { MessageResult } from '../../message-handle/index.js';
import type { NormalizedMessageInput } from '../../utils/normalizeMessageInput.js';

type TestBus = ReturnType<typeof createMockScopedBus>['bus'];

/** Connector fixture exposing protected turn-number helpers for contract tests. */
class TurnNumberConnector extends AIAgentConnector<TestBus> {
  public constructor(config: BaseAgentConnectorConfig<TestBus> & { adapterId: string }) {
    super(config);
  }

  public async initialize(_options?: ConnectorStartOptions): Promise<void> {}

  public async start(message: NormalizedMessageInput): Promise<AgentStartResult> {
    return {
      adapterSessionId: 'adapter-session-1',
      agentId: this.getAgentId(),
      messageHandle: new MessageHandle('message-1', message, 'enqueue'),
    };
  }

  public async sendMessage(message: NormalizedMessageInput): Promise<MessageHandle> {
    return new MessageHandle('message-1', message, 'enqueue');
  }

  public abort(): void {}

  public async close(): Promise<void> {}

  public async getAdapterSessionId(): Promise<string> {
    return 'adapter-session-1';
  }

  public async complete(): Promise<MessageResult | null> {
    return null;
  }

  public async interrupt(): Promise<void> {}

  public consumeTurnNumberForTest(): number {
    return this.consumeTurnNumber();
  }

  public get pendingTurnNumberForTest(): number | undefined {
    return this.pendingTurnNumber;
  }
}

/**
 * Create a connector fixture for turn-number contract tests.
 * @returns Connector with mocked scoped bus
 */
function createConnector(): TurnNumberConnector {
  const { bus } = createMockScopedBus();
  return new TurnNumberConnector({
    bus,
    adapterId: 'adapter-1',
    adapterName: 'test-adapter',
    agentId: 'agent-1',
    model: 'test-model',
    cwd: process.cwd(),
  });
}

describe('AIAgentConnector canonical turn numbers', () => {
  it('stages and consumes positive integer canonical turn numbers', () => {
    const connector = createConnector();

    connector.setCanonicalTurnNumber(3);

    expect(connector.pendingTurnNumberForTest).toBe(3);
    expect(connector.consumeTurnNumberForTest()).toBe(3);
    expect(connector.pendingTurnNumberForTest).toBeUndefined();
  });

  it('rejects invalid canonical turn numbers without replacing the staged value', () => {
    const connector = createConnector();
    connector.setCanonicalTurnNumber(7);

    for (const turnNumber of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => connector.setCanonicalTurnNumber(turnNumber)).toThrow(RangeError);
    }

    expect(connector.pendingTurnNumberForTest).toBe(7);
  });

  it('rejects a turn number that would move the counter backwards after consumption', () => {
    const connector = createConnector();

    // Advance the counter to turn 5.
    connector.setCanonicalTurnNumber(5);
    expect(connector.consumeTurnNumberForTest()).toBe(5);

    // Attempting to stage anything <= 5 must throw.
    expect(() => connector.setCanonicalTurnNumber(5)).toThrow(RangeError);
    expect(() => connector.setCanonicalTurnNumber(3)).toThrow(RangeError);
    expect(() => connector.setCanonicalTurnNumber(1)).toThrow(RangeError);

    // Staging a strictly higher value must succeed.
    expect(() => connector.setCanonicalTurnNumber(6)).not.toThrow();
    expect(connector.pendingTurnNumberForTest).toBe(6);
  });

  it('rejects a turn number that would downgrade an already-staged pending value', () => {
    const connector = createConnector();

    // Stage turn 10.
    connector.setCanonicalTurnNumber(10);
    expect(connector.pendingTurnNumberForTest).toBe(10);

    // A lower staged value must be rejected and must not replace the pending value.
    expect(() => connector.setCanonicalTurnNumber(9)).toThrow(RangeError);
    expect(() => connector.setCanonicalTurnNumber(5)).toThrow(RangeError);
    expect(connector.pendingTurnNumberForTest).toBe(10);

    // Re-staging the same value is idempotent (not a regression) and must not throw.
    expect(() => connector.setCanonicalTurnNumber(10)).not.toThrow();

    // A strictly higher value replaces the staged value.
    connector.setCanonicalTurnNumber(11);
    expect(connector.pendingTurnNumberForTest).toBe(11);
  });
});
