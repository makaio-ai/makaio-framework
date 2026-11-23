import { describe, it, expect, vi } from 'vitest';
import { MessageHandle } from '@makaio/ai-adapters-core';
import { createTestBusInstance, createTestCall } from '@makaio/test-utils';
import { TmuxConnectorTurn } from '../turn.js';
import { ClaudeCodeTmuxConnectorNamespace } from '../namespace/index.js';

function makeMockHandle(): MessageHandle {
  return new MessageHandle(
    createTestCall(),
    'msg-1',
    { role: 'user', blocks: [{ type: 'text', content: 'hello' }], message: 'hello' },
    'enqueue',
  );
}

async function makeTurn(
  requestInterrupt = vi.fn(),
  onInterruptSettledWithoutStop = vi.fn(),
  interruptSettleMs = 1_000,
): Promise<TmuxConnectorTurn> {
  const hostBus = createTestBusInstance();
  hostBus.registerNamespaces([ClaudeCodeTmuxConnectorNamespace.definition]);
  return new TmuxConnectorTurn(
    await ClaudeCodeTmuxConnectorNamespace.scopedBus(hostBus),
    'adapter-1',
    'claude-code-tmux',
    'agent-1',
    makeMockHandle(),
    requestInterrupt,
    interruptSettleMs,
    onInterruptSettledWithoutStop,
  );
}

describe('TmuxConnectorTurn', () => {
  it('starts in idle state', async () => {
    const turn = await makeTurn();
    expect(turn.getState()).toBe('idle');
  });

  it('transitions through the full hook-driven lifecycle', async () => {
    const hostBus = createTestBusInstance();
    hostBus.registerNamespaces([ClaudeCodeTmuxConnectorNamespace.definition]);
    const bus = await ClaudeCodeTmuxConnectorNamespace.scopedBus(hostBus);
    const turn = new TmuxConnectorTurn(
      bus,
      'adapter-1',
      'claude-code-tmux',
      'agent-1',
      makeMockHandle(),
      vi.fn(),
      1_000,
      vi.fn(),
    );

    await turn.start(createTestCall());
    expect(turn.getState()).toBe('turn_started');

    await turn.markStepStarted(createTestCall());
    expect(turn.getState()).toBe('step_started');

    await turn.markStepFinished(createTestCall());
    expect(turn.getState()).toBe('step_finished');

    await turn.markTurnFinished(createTestCall());
    expect(turn.getState()).toBe('turn_finished');
    expect(turn.isCompleted()).toBe(true);
  });

  it('supports multiple tool use cycles (step_finished → step_started)', async () => {
    const turn = await makeTurn();

    await turn.start(createTestCall());
    await turn.markStepStarted(createTestCall());
    await turn.markStepFinished(createTestCall());
    expect(turn.getState()).toBe('step_finished');

    await turn.markStepStarted(createTestCall());
    expect(turn.getState()).toBe('step_started');

    await turn.markStepFinished(createTestCall());
    await turn.markTurnFinished(createTestCall());
    expect(turn.isCompleted()).toBe(true);
  });

  it('pause returns turnEnded: true when already finished', async () => {
    const turn = await makeTurn();
    await turn.start(createTestCall());
    await turn.markTurnFinished(createTestCall());

    const result = await turn.pause();
    expect(result.turnEnded).toBe(true);
  });

  it('sends Escape and consumes Stop as interrupt acknowledgement', async () => {
    const requestInterrupt = vi.fn();
    const turn = await makeTurn(requestInterrupt);
    await turn.start(createTestCall());

    expect(turn.canAcceptImmediate()).toBe(true);
    const resultPromise = turn.pause();
    expect(requestInterrupt).toHaveBeenCalledOnce();
    expect(turn.canAcceptImmediate()).toBe(false);
    expect(turn.isPaused()).toBe(true);

    expect(turn.acknowledgeInterrupt()).toBe(true);

    const result = await resultPromise;
    expect(result.turnEnded).toBe(false);
    expect(turn.isPaused()).toBe(true);
    expect(turn.shouldIgnoreStop()).toBe(true);
  });

  it('settles without Stop and notifies the session to suppress stale Stop hooks', async () => {
    const requestInterrupt = vi.fn();
    const onInterruptSettledWithoutStop = vi.fn();
    const turn = await makeTurn(requestInterrupt, onInterruptSettledWithoutStop, 1);
    await turn.start(createTestCall());

    const result = await turn.pause();

    expect(result.turnEnded).toBe(false);
    expect(requestInterrupt).toHaveBeenCalledOnce();
    expect(onInterruptSettledWithoutStop).toHaveBeenCalledOnce();
    expect(turn.shouldIgnoreStop()).toBe(true);
  });

  it('resume throws (tmux does not support resume)', async () => {
    const turn = await makeTurn();
    await expect(turn.resume(createTestCall())).rejects.toThrow(/does not support resume/);
  });
});
