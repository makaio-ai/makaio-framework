/// <reference types="bun-types" />
import { describe, expect, it, mock } from 'bun:test';
import { MessageHandle, UserMessageQueue } from '@makaio/ai-adapters-core';
import { TmuxConnectorSession } from '../connector-session.js';
import { TmuxSession } from '../session.js';
import { ClaudeCodeTmuxConnectorNamespace } from '../namespace/index.js';
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
    write: mock(),
    resize: mock(),
    kill: mock(),
    onData: mock(() => ({ dispose: mock() })),
    onExit: mock(() => ({ dispose: mock() })),
    sendKey: mock(),
    captureVisible: mock(() => captures.shift() ?? changedComposer),
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
    onTurnStart: mock(),
    onTurnComplete: mock(),
    emitTurnCompleted: mock<() => Promise<void>>().mockResolvedValue(undefined),
    emitToolUseStarted:
      mock<(payload: { toolName: string; toolUseId: string; toolInput: unknown }) => Promise<void>>().mockResolvedValue(
        undefined,
      ),
    emitToolUseFinished:
      mock<
        (payload: { toolName: string; toolUseId: string; toolResult: unknown; isError?: boolean }) => Promise<void>
      >().mockResolvedValue(undefined),
    interruptSettleMs: 1,
    ...overrides,
  });
}

describe('TmuxConnectorSession', () => {
  it('detaches the active turn when completion callbacks throw', async () => {
    const session = await makeSession({
      onTurnComplete: mock(() => {
        throw new Error('completion callback failed');
      }),
    });
    const queue = new UserMessageQueue();
    queue.enqueue(makeHandle());

    await expect(session.processQueue(queue)).resolves.toBe(true);
    await expect(session.handleTurnFinished('done')).rejects.toThrow('completion callback failed');

    expect(session.getCurrentTurn()).toBeUndefined();
  });

  it('detaches the active turn when start callbacks throw', async () => {
    const session = await makeSession({
      onTurnStart: mock(() => {
        throw new Error('start callback failed');
      }),
    });
    const queue = new UserMessageQueue();
    queue.enqueue(makeHandle());

    await expect(session.processQueue(queue)).rejects.toThrow('start callback failed');

    expect(session.getCurrentTurn()).toBeUndefined();
  });
});
