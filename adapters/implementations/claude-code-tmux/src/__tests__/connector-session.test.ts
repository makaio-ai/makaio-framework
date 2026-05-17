import { describe, expect, it, vi } from 'vitest';
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
      .fn<(payload: { toolName: string; toolUseId: string; toolInput: unknown }) => Promise<void>>()
      .mockResolvedValue(undefined),
    emitToolUseFinished: vi
      .fn<(payload: { toolName: string; toolUseId: string; toolResult: unknown; isError?: boolean }) => Promise<void>>()
      .mockResolvedValue(undefined),
    interruptSettleMs: 1,
    ...overrides,
  });
}

describe('TmuxConnectorSession', () => {
  it('detaches the active turn when completion callbacks throw', async () => {
    const session = await makeSession({
      onTurnComplete: vi.fn(() => {
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
      onTurnStart: vi.fn(() => {
        throw new Error('start callback failed');
      }),
    });
    const queue = new UserMessageQueue();
    queue.enqueue(makeHandle());

    await expect(session.processQueue(queue)).rejects.toThrow('start callback failed');

    expect(session.getCurrentTurn()).toBeUndefined();
  });
});
