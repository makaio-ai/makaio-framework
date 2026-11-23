import { describe, expect, it, vi } from 'vitest';
import { MessageHandle, normalizeMessageInput } from '@makaio/ai-adapters-core';
import { MakaioBus } from '@makaio/bus-core';
import { createTestCall } from '@makaio/test-utils';
import type { CallContext } from '@makaio/contracts';
import { createClaudeConnectorNamespace } from '../namespace/index.js';
import { ClaudeConnectorTurn } from './claude-connector-turn.js';

interface PauseResult {
  stateBeforePause: 'turn_finished';
  turnEnded: boolean;
}

/**
 * Creates a deterministic MessageHandle fixture for turn tests.
 *
 * Uses `normalizeMessageInput` to construct the message payload and returns a
 * `MessageHandle` bound to adapter session `session-1`.
 * @param call - Call of the message driving the turn.
 * @returns MessageHandle initialized with id `message-1`, content `hello`, and adapterSessionId `session-1`.
 */
function createMessageHandle(call: CallContext): MessageHandle {
  const handle = new MessageHandle(call, 'message-1', normalizeMessageInput('hello'), 'enqueue');
  handle.adapterSessionId = 'session-1';
  return handle;
}

describe('ClaudeConnectorTurn.finishOnError', () => {
  it('unblocks pause waiters and completes the turn without pausing', async () => {
    const namespace = createClaudeConnectorNamespace(
      `adapter:claude-turn-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    MakaioBus.registerNamespaces([namespace.definition]);
    const bus = await namespace.scopedBus(MakaioBus);
    const call = createTestCall();
    const interrupt = vi.fn(async () => {});
    const turn = new ClaudeConnectorTurn(
      bus,
      namespace.subjects,
      'adapter-1',
      'claude-code',
      'agent-1',
      { interrupt },
      createMessageHandle(call),
    );

    await turn.start(call);
    const pausePromise = turn.pause(call);
    await turn.finishOnError(call);

    const expectedPauseResult: PauseResult = {
      stateBeforePause: 'turn_finished',
      turnEnded: true,
    };
    await expect(pausePromise).resolves.toEqual(expectedPauseResult);
    expect(interrupt).not.toHaveBeenCalled();
    expect(turn.isCompleted()).toBe(true);
  });
});
