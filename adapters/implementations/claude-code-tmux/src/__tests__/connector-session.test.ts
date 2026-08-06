import { describe, expect, it, vi } from 'vitest';
import { MessageHandle, UserMessageQueue } from '@makaio/ai-adapters-core';
import { TmuxConnectorSession } from '../connector-session.js';
import { TmuxSession } from '../session.js';
import { ClaudeCodeTmuxConnectorNamespace, ClaudeCodeTmuxConnectorSubjects } from '../namespace/index.js';
import type { ITmuxPtyProcess } from '../types.js';

function makeHandle(message = 'hello'): MessageHandle {
  return new MessageHandle(
    crypto.randomUUID(),
    { role: 'user', blocks: [{ type: 'text', content: message }], message },
    'enqueue',
  );
}

function makeTmuxSession(): TmuxSession {
  const visibleComposer = '❯ ready tokens';
  const changedComposer = 'hello\n❯ ready tokens';
  const captures = [visibleComposer, visibleComposer, changedComposer];
  const ptyProcess: ITmuxPtyProcess = {
    pid: 1234,
    process: 'claude',
    cols: 80,
    rows: 24,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn(() => ({ dispose: vi.fn() })),
    sendKey: vi.fn(),
    captureVisible: vi.fn(() => captures.shift() ?? changedComposer),
  };

  return new TmuxSession({ ptyProcess, expectedClaudeSessionId: 'claude-session-1' });
}

async function makeSession(
  overrides: Partial<ConstructorParameters<typeof TmuxConnectorSession>[0]> = {},
): Promise<TmuxConnectorSession> {
  return new TmuxConnectorSession({
    tmuxSession: makeTmuxSession(),
    bus: await ClaudeCodeTmuxConnectorNamespace.scopedBus(),
    adapterId: 'adapter-1',
    adapterName: 'claude-code-tmux',
    agentId: 'agent-1',
    onTurnStart: vi.fn(),
    onTurnComplete: vi.fn(),
    emitTurnCompleted: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    emitToolUseStarted: vi
      .fn<(payload: { messageId: string; toolName: string; toolUseId: string; toolInput: unknown }) => Promise<void>>()
      .mockResolvedValue(undefined),
    emitToolUseFinished: vi
      .fn<
        (payload: {
          messageId: string;
          toolName: string;
          toolUseId: string;
          toolResult: unknown;
          isError?: boolean;
        }) => Promise<void>
      >()
      .mockResolvedValue(undefined),
    interruptSettleMs: 1,
    ...overrides,
  });
}

describe('TmuxConnectorSession', () => {
  it('detaches the active turn when completion callbacks throw', async () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const session = await makeSession({
        onTurnComplete: vi.fn(() => {
          throw new Error('completion callback failed');
        }),
      });
      const queue = new UserMessageQueue();
      queue.enqueue(makeHandle());

      await expect(session.processQueue(queue)).resolves.toBe(true);
      await expect(session.handleTurnFinished('done')).resolves.toBeUndefined();

      expect(session.getCurrentTurn()).toBeUndefined();
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.stringMatching(/completion notification failed/),
        expect.any(Error),
      );
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('detaches the active turn when start callbacks throw', async () => {
    const session = await makeSession({
      onTurnStart: vi.fn(() => {
        throw new Error('start callback failed');
      }),
    });
    const queue = new UserMessageQueue();
    queue.enqueue(makeHandle());

    await expect(session.processQueue(queue)).rejects.toThrow('start callback failed');

    expect(session.getCurrentTurn()).toBeUndefined();
  });

  it('finalises a turn once when an exit arrives while a teardown is already finalising it', async () => {
    // The completion guard sits before the first await, so two finalisers can
    // both pass it and the count — not the guard — is what proves the fix. This
    // is a reachable race, not a constructed one: teardown finalises the active
    // turn, and the retained process-exit listener finalises the same turn
    // through the same method when the process dies during that teardown.
    let releaseFirstFinalisation: () => void = () => {};
    const firstFinalisationGate = new Promise<void>((resolve) => {
      releaseFirstFinalisation = resolve;
    });
    const onTurnComplete = vi.fn(async () => {
      await firstFinalisationGate;
    });

    // The turn's own terminal transition is the count that matters. The message
    // handle refuses a second completion on its own, so counting handle
    // callbacks would pass without any fix at all; the turn transition does not
    // refuse, and emits `turn.turn_finished` every time it is driven.
    const bus = await ClaudeCodeTmuxConnectorNamespace.scopedBus();
    const turnFinishedEvents: unknown[] = [];
    await bus.on(ClaudeCodeTmuxConnectorSubjects.turn.turn_finished, (payload) => {
      turnFinishedEvents.push(payload);
    });

    const session = await makeSession({ bus, onTurnComplete });
    const queue = new UserMessageQueue();
    queue.enqueue(makeHandle());
    await session.processQueue(queue);

    const fromTeardown = session.handleTurnError(new Error('session terminated'));
    // Let the first finalisation reach the await it blocks on, so the second
    // caller provably arrives mid-finalisation rather than after it.
    await vi.waitFor(() => {
      expect(onTurnComplete).toHaveBeenCalled();
    });
    const fromProcessExit = session.handleTurnError(new Error('process exited before turn completion'));

    releaseFirstFinalisation();
    await Promise.all([fromTeardown, fromProcessExit]);

    expect(turnFinishedEvents).toHaveLength(1);
    expect(session.getCurrentTurn()).toBeUndefined();
  });

  it('drops a post-tool hook after the owning turn terminates with an error', async () => {
    const emitToolUseFinished = vi
      .fn<
        (payload: {
          messageId: string;
          toolName: string;
          toolUseId: string;
          toolResult: unknown;
          isError?: boolean;
        }) => Promise<void>
      >()
      .mockResolvedValue(undefined);
    const session = await makeSession({ emitToolUseFinished });
    const queue = new UserMessageQueue();
    queue.enqueue(makeHandle());
    await session.processQueue(queue);

    await session.handlePreToolUse('Read', 'tool-abandoned', { path: 'stale.txt' });
    await session.handleTurnError(new Error('connector closed'));
    await session.handlePostToolUse('Read', 'tool-abandoned', 'stale output');

    expect(emitToolUseFinished).not.toHaveBeenCalled();
  });
});
