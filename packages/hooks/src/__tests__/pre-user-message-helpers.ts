/**
 * Shared test helpers for PreUserMessage hook tests.
 */

import type { PreUserMessageInput } from '../runners/pre-user-message-runner.js';

/**
 * Create a valid PreUserMessageInput payload with optional overrides.
 * @param overrides - Optional payload overrides
 * @returns Complete PreUserMessageInput for testing
 */
export function createRunnerInput(overrides: Partial<PreUserMessageInput> = {}): PreUserMessageInput {
  return {
    agentId: 'agent-1',
    adapterId: 'adapter-1',
    message: 'Hello',
    sessionId: 'session-1',
    sessionContext: { messageHistory: [] },
    ...overrides,
  };
}
