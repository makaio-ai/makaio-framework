import { describe, expect, it, vi } from 'vitest';
import { MessageHandle, UserMessageQueue } from '@makaio/ai-adapters-core';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import type { CallContext, Party } from '@makaio/contracts';
import { createTestCall } from '@makaio/test-utils';
import { TmuxConnectorSession } from '../connector-session.js';
import { TmuxSession } from '../session.js';
import { ClaudeCodeTmuxConnectorNamespace, ClaudeCodeTmuxConnectorSubjects } from '../namespace/index.js';
import type { ITmuxPtyProcess } from '../types.js';

const PERSON_A: Party = { kind: 'acme.person', id: 'person-a' };
const PERSON_B: Party = { kind: 'acme.person', id: 'person-b' };

type ToolStartedPayload = { messageId: string; toolName: string; toolUseId: string; toolInput: unknown };
type ToolFinishedPayload = {
  messageId: string;
  toolName: string;
  toolUseId: string;
  toolResult: unknown;
  isError?: boolean;
};

function makeHandle(message = 'hello', call: CallContext = createTestCall()): MessageHandle {
  return new MessageHandle(
    call,
    crypto.randomUUID(),
    { role: 'user', blocks: [{ type: 'text', content: message }], message },
    'enqueue',
  );
}

function makeTmuxSession(bus: IMakaioBus): TmuxSession {
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

  return new TmuxSession({ bus, ptyProcess, expectedClaudeSessionId: 'claude-session-1' });
}

async function makeSession(
  overrides: Partial<ConstructorParameters<typeof TmuxConnectorSession>[0]> = {},
): Promise<TmuxConnectorSession> {
  const hostBus = createBusInstance();
  return new TmuxConnectorSession({
    tmuxSession: makeTmuxSession(hostBus),
    bus: await ClaudeCodeTmuxConnectorNamespace.scopedBus(hostBus),
    adapterId: 'adapter-1',
    adapterName: 'claude-code-tmux',
    agentId: 'agent-1',
    onTurnStart: vi.fn(),
    onTurnComplete: vi.fn(),
    emitTurnCompleted: vi.fn<(call: CallContext, payload: { message: string }) => Promise<void>>().mockResolvedValue(),
    emitToolUseStarted: vi.fn<(call: CallContext, payload: ToolStartedPayload) => Promise<void>>().mockResolvedValue(),
    emitToolUseFinished: vi
      .fn<(call: CallContext, payload: ToolFinishedPayload) => Promise<void>>()
      .mockResolvedValue(),
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
    const hostBus = createBusInstance();
    const bus = await ClaudeCodeTmuxConnectorNamespace.scopedBus(hostBus);
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
      .fn<(call: CallContext, payload: ToolFinishedPayload) => Promise<void>>()
      .mockResolvedValue();
    const session = await makeSession({ emitToolUseFinished });
    const queue = new UserMessageQueue();
    queue.enqueue(makeHandle());
    await session.processQueue(queue);

    await session.handlePreToolUse('Read', 'tool-abandoned', { path: 'stale.txt' });
    await session.handleTurnError(new Error('connector closed'));
    await session.handlePostToolUse('Read', 'tool-abandoned', 'stale output');

    expect(emitToolUseFinished).not.toHaveBeenCalled();
  });

  describe('origin of emissions (hook callbacks carry no turn id)', () => {
    it('emits completion under the call of the handle that originated it, also after the connector slot cleared', async () => {
      // The connector's pending-handle slot is cleared by `onTurnComplete` before the completion is emitted;
      // the emission must not consult it.
      let slot: MessageHandle | undefined;
      const slotAtEmission: Array<MessageHandle | undefined> = [];
      const emitTurnCompleted = vi
        .fn<(call: CallContext, payload: { message: string }) => Promise<void>>()
        .mockImplementation(async () => {
          slotAtEmission.push(slot);
        });
      const session = await makeSession({
        onTurnStart: (handle) => {
          slot = handle;
        },
        onTurnComplete: () => {
          slot = undefined;
        },
        emitTurnCompleted,
      });
      const handle = makeHandle('hello', createTestCall({ principal: PERSON_A }));
      const queue = new UserMessageQueue();
      queue.enqueue(handle);
      await session.processQueue(queue);

      await session.handleTurnFinished('done');

      expect(emitTurnCompleted).toHaveBeenCalledTimes(1);
      expect(emitTurnCompleted).toHaveBeenCalledWith(handle.call, { message: 'done' });
      expect(emitTurnCompleted.mock.calls[0]?.[0].principal).toEqual(PERSON_A);
      expect(slotAtEmission).toEqual([undefined]);
    });

    it('emits tool start under the active handle call and tool finish under the retained origin after supersession', async () => {
      const emitToolUseStarted = vi
        .fn<(call: CallContext, payload: ToolStartedPayload) => Promise<void>>()
        .mockResolvedValue();
      const emitToolUseFinished = vi
        .fn<(call: CallContext, payload: ToolFinishedPayload) => Promise<void>>()
        .mockResolvedValue();
      const session = await makeSession({ emitToolUseStarted, emitToolUseFinished });
      const first = makeHandle('first', createTestCall({ principal: PERSON_A }));
      const second = makeHandle('second', createTestCall({ principal: PERSON_B }));
      const queue = new UserMessageQueue();
      queue.enqueue(first);
      await session.processQueue(queue);

      await session.handlePreToolUse('Read', 'tool-1', { path: 'a.txt' });
      expect(emitToolUseStarted).toHaveBeenCalledWith(first.call, {
        messageId: first.messageId,
        toolName: 'Read',
        toolUseId: 'tool-1',
        toolInput: { path: 'a.txt' },
      });

      // A later turn begins before the matching PostToolUse arrives.
      await session.handleTurnFinished('first done');
      queue.enqueue(second);
      await session.processQueue(queue);
      await session.handlePostToolUse('Read', 'tool-1', 'contents', false);

      expect(emitToolUseFinished).toHaveBeenCalledTimes(1);
      expect(emitToolUseFinished).toHaveBeenCalledWith(first.call, {
        messageId: first.messageId,
        toolName: 'Read',
        toolUseId: 'tool-1',
        toolResult: 'contents',
        isError: false,
      });
    });

    it('does not attribute a Stop or PreToolUse arriving after a later turn began to the earlier turn', async () => {
      const emitTurnCompleted = vi
        .fn<(call: CallContext, payload: { message: string }) => Promise<void>>()
        .mockResolvedValue();
      const emitToolUseStarted = vi
        .fn<(call: CallContext, payload: ToolStartedPayload) => Promise<void>>()
        .mockResolvedValue();
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
      try {
        const session = await makeSession({ emitTurnCompleted, emitToolUseStarted });
        const first = makeHandle('first', createTestCall({ principal: PERSON_A }));
        const second = makeHandle('second', createTestCall({ principal: PERSON_B }));
        const queue = new UserMessageQueue();
        queue.enqueue(first);
        await session.processQueue(queue);
        await session.handleTurnFinished('first done');

        // Late Stop of the first turn while no turn is active: no eligible turn, nothing emitted.
        await session.handleTurnFinished('late stop of first');
        expect(emitTurnCompleted).toHaveBeenCalledTimes(1);

        queue.enqueue(second);
        await session.processQueue(queue);
        await session.handlePreToolUse('Read', 'tool-2', {});

        expect(emitToolUseStarted).toHaveBeenCalledTimes(1);
        expect(emitToolUseStarted.mock.calls[0]?.[0]).toBe(second.call);
        expect(emitToolUseStarted.mock.calls[0]?.[0]).not.toBe(first.call);
        expect(emitToolUseStarted.mock.calls[0]?.[1].messageId).toBe(second.messageId);
      } finally {
        debug.mockRestore();
      }
    });

    it('emits nothing and logs when a hook has no origin', async () => {
      const emitTurnCompleted = vi
        .fn<(call: CallContext, payload: { message: string }) => Promise<void>>()
        .mockResolvedValue();
      const emitToolUseStarted = vi
        .fn<(call: CallContext, payload: ToolStartedPayload) => Promise<void>>()
        .mockResolvedValue();
      const emitToolUseFinished = vi
        .fn<(call: CallContext, payload: ToolFinishedPayload) => Promise<void>>()
        .mockResolvedValue();
      const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
      try {
        const session = await makeSession({ emitTurnCompleted, emitToolUseStarted, emitToolUseFinished });

        await session.handleTurnFinished('stray stop');
        await session.handlePreToolUse('Read', 'tool-orphan-start', {});
        await session.handlePostToolUse('Read', 'tool-orphan-finish', 'x');

        expect(emitTurnCompleted).not.toHaveBeenCalled();
        expect(emitToolUseStarted).not.toHaveBeenCalled();
        expect(emitToolUseFinished).not.toHaveBeenCalled();
        expect(debug).toHaveBeenCalledWith(expect.stringMatching(/PreToolUse has no active turn/), {
          toolUseId: 'tool-orphan-start',
        });
        expect(debug).toHaveBeenCalledWith(expect.stringMatching(/PostToolUse has no retained origin/), {
          toolUseId: 'tool-orphan-finish',
        });
        expect(debug).toHaveBeenCalledWith(expect.stringMatching(/Stop hook has no eligible turn/));
      } finally {
        debug.mockRestore();
      }
    });
  });
});
