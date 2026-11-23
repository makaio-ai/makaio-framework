import { vi } from 'vitest';
import type { CallContext } from '@makaio/contracts';
import type { IMakaioBus } from '@makaio/bus-core';
import type { AIAgentConnector } from '../../connector/index.js';
import type { AgentTurnExecutorConfig } from '../agent-turn-executor.js';
import { MessageHandle } from '../../message-handle/index.js';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

export function createDeferred<T>(): Deferred<T> {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

/**
 * Create a queued user-message handle for executor tests.
 * @param call - Call of the operation served by the handle.
 * @param messageId - Identity returned by the connector.
 * @param content - User message text.
 * @returns A handle for the queued message.
 */
export function createMessageHandle(call: CallContext, messageId: string, content: string): MessageHandle {
  return new MessageHandle(call, messageId, { role: 'user', blocks: [{ type: 'text', content }] }, 'enqueue');
}

/**
 * Build the common executor dependencies for a connector fixture.
 * @param connector - Connector used by the test.
 * @returns Shared dependencies with fresh lifecycle spies.
 */
export function createExecutorConfig(
  connector: Partial<AIAgentConnector>,
): Pick<
  AgentTurnExecutorConfig,
  'globalBus' | 'getConnector' | 'shouldUseNativeResume' | 'hasResumeTarget' | 'setPendingStartMode'
> {
  return {
    globalBus: {} as IMakaioBus,
    getConnector: () => connector as AIAgentConnector,
    shouldUseNativeResume: () => false,
    hasResumeTarget: () => false,
    setPendingStartMode: vi.fn(),
  };
}
