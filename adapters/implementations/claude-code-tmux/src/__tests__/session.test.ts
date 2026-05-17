import { afterEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { ClaudeCodeClientSubjects } from '@makaio/client-claude-code/runtime';
import { TmuxSession } from '../session.js';
import type { ITmuxPtyProcess } from '../types.js';
import type { HookEventCallbacks } from '../utils/hook-event-router.js';

function makePtyProcess(): ITmuxPtyProcess {
  const visibleComposer = '❯ ready tokens';
  const changedComposer = 'hello\n❯ ready tokens';
  const captures = [visibleComposer, visibleComposer, changedComposer];
  return {
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
}

function makeCallbacks(): HookEventCallbacks {
  return {
    onSessionStart: vi.fn(),
    onUserPromptSubmit: vi.fn(),
    onPreToolUse: vi.fn(),
    onPostToolUse: vi.fn(),
    onStop: vi.fn(),
  };
}

describe('TmuxSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    MakaioBus.__resetHandlers?.();
  });

  it('subscribes to hook events with the expected Claude session filter', () => {
    const onSpy = vi.spyOn(MakaioBus, 'on');
    const session = new TmuxSession({
      ptyProcess: makePtyProcess(),
      expectedClaudeSessionId: 'claude-session-123',
    });

    const unsubscribe = session.subscribeToHooks(makeCallbacks());

    expect(onSpy).toHaveBeenCalledWith(ClaudeCodeClientSubjects.hook.received, expect.any(Function), {
      filter: { 'payload.session_id': 'claude-session-123' },
    });

    unsubscribe();
  });

  it('sends Escape via tmux named-key delivery', () => {
    const ptyProcess = makePtyProcess();
    const session = new TmuxSession({
      ptyProcess,
      expectedClaudeSessionId: 'claude-session-123',
    });

    session.sendEscape();

    expect(ptyProcess.sendKey).toHaveBeenCalledWith('Escape');
    expect(ptyProcess.write).not.toHaveBeenCalled();
  });

  it('sends message text via write and submits via named-key Enter', async () => {
    const ptyProcess = makePtyProcess();
    const session = new TmuxSession({
      ptyProcess,
      expectedClaudeSessionId: 'claude-session-123',
    });

    await session.sendMessage('hello');

    expect(ptyProcess.write).toHaveBeenCalledWith('hello');
    expect(ptyProcess.sendKey).toHaveBeenCalledWith('Enter');
  });

  it('fails fast when the composer never becomes visible', async () => {
    const ptyProcess = makePtyProcess();
    vi.mocked(ptyProcess.captureVisible).mockReturnValue(null);
    const session = new TmuxSession({
      ptyProcess,
      expectedClaudeSessionId: 'claude-session-123',
    });

    await expect(session.waitForInputReady(5, 1)).rejects.toThrow(/Timed out waiting for Claude input composer/);
  });

  it('clears draft input via named-key C-c', () => {
    const ptyProcess = makePtyProcess();
    const session = new TmuxSession({
      ptyProcess,
      expectedClaudeSessionId: 'claude-session-123',
    });

    session.clearInput();

    expect(ptyProcess.sendKey).toHaveBeenCalledWith('C-c');
    expect(ptyProcess.write).not.toHaveBeenCalled();
  });
});
