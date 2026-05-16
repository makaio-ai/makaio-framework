import { afterEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects } from '@makaio/contracts';
import type { AgentStarted, AgentComplete, ToolCompleted } from '@makaio/contracts';
import { registerHooks } from '../../src/shared/hooks.js';
import type { HookCallback, HookEventData } from '../../src/shared/hooks.js';

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-hooks-1';
const AGENT_ID = 'agent-hooks-1';

const BASE = {
  agentId: AGENT_ID,
  adapterId: 'adapter-1',
  adapterName: 'test',
  adapterSessionId: 'as-1',
  sessionId: SESSION_ID,
} as const;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerHooks', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
  });

  it('returns a function', () => {
    const cleanup = registerHooks(MakaioBus, SESSION_ID, {});
    cleanups.push(cleanup);
    expect(typeof cleanup).toBe('function');
  });

  // -------------------------------------------------------------------------
  // SessionStart → agent.started
  // -------------------------------------------------------------------------

  it('invokes SessionStart callback when agent.started fires for matching session', async () => {
    const cb = vi.fn<HookCallback>();
    const cleanup = registerHooks(MakaioBus, SESSION_ID, { SessionStart: cb });
    cleanups.push(cleanup);

    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE,
      model: 'sonnet',
      cwd: '/tmp',
    } satisfies AgentStarted);

    expect(cb).toHaveBeenCalledOnce();
    const event = cb.mock.calls[0][0] as HookEventData;
    expect(event.type).toBe('SessionStart');
    expect(event.sessionId).toBe(SESSION_ID);
    expect(event.agentId).toBe(AGENT_ID);
    expect(event.payload).toMatchObject({ model: 'sonnet' });
  });

  it('does not invoke SessionStart callback for a different sessionId', async () => {
    const cb = vi.fn<HookCallback>();
    const cleanup = registerHooks(MakaioBus, SESSION_ID, { SessionStart: cb });
    cleanups.push(cleanup);

    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE,
      sessionId: 'other-session',
      model: 'sonnet',
      cwd: '/tmp',
    } satisfies AgentStarted);

    expect(cb).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // SessionEnd / Stop → agent.complete
  // -------------------------------------------------------------------------

  it('invokes SessionEnd callback when agent.complete fires', async () => {
    const cb = vi.fn<HookCallback>();
    const cleanup = registerHooks(MakaioBus, SESSION_ID, { SessionEnd: cb });
    cleanups.push(cleanup);

    await MakaioBus.emit(AgentSubjects.complete, {
      ...BASE,
      messageId: 'msg-1',
      message: 'done',
      outcome: 'completed',
    } satisfies AgentComplete);

    expect(cb).toHaveBeenCalledOnce();
    const event = cb.mock.calls[0][0] as HookEventData;
    expect(event.type).toBe('SessionEnd');
  });

  it('invokes Stop callback when agent.complete fires', async () => {
    const cb = vi.fn<HookCallback>();
    const cleanup = registerHooks(MakaioBus, SESSION_ID, { Stop: cb });
    cleanups.push(cleanup);

    await MakaioBus.emit(AgentSubjects.complete, {
      ...BASE,
      messageId: 'msg-2',
      message: 'stopped',
      outcome: 'completed',
    } satisfies AgentComplete);

    expect(cb).toHaveBeenCalledOnce();
    expect((cb.mock.calls[0][0] as HookEventData).type).toBe('Stop');
  });

  it('invokes both SessionEnd and Stop callbacks when both are registered', async () => {
    const cbEnd = vi.fn<HookCallback>();
    const cbStop = vi.fn<HookCallback>();
    const cleanup = registerHooks(MakaioBus, SESSION_ID, {
      SessionEnd: cbEnd,
      Stop: cbStop,
    });
    cleanups.push(cleanup);

    await MakaioBus.emit(AgentSubjects.complete, {
      ...BASE,
      messageId: 'msg-3',
      outcome: 'completed',
    } satisfies AgentComplete);

    expect(cbEnd).toHaveBeenCalledOnce();
    expect(cbStop).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // PreToolUse → agent.tool.use
  // -------------------------------------------------------------------------

  it('invokes PreToolUse callback when agent.tool.use fires', async () => {
    const cb = vi.fn<HookCallback>();
    const cleanup = registerHooks(MakaioBus, SESSION_ID, { PreToolUse: cb });
    cleanups.push(cleanup);

    await MakaioBus.emit(AgentSubjects.tool.use, {
      ...BASE,
      toolName: 'read_file',
      toolCallId: 'tc-1',
      args: { path: '/foo' },
    });

    expect(cb).toHaveBeenCalledOnce();
    const event = cb.mock.calls[0][0] as HookEventData;
    expect(event.type).toBe('PreToolUse');
    expect(event.payload).toMatchObject({ toolName: 'read_file' });
  });

  // -------------------------------------------------------------------------
  // PostToolUse → agent.tool.completed
  // -------------------------------------------------------------------------

  it('invokes PostToolUse callback when agent.tool.completed fires', async () => {
    const cb = vi.fn<HookCallback>();
    const cleanup = registerHooks(MakaioBus, SESSION_ID, { PostToolUse: cb });
    cleanups.push(cleanup);

    await MakaioBus.emit(AgentSubjects.tool.completed, {
      ...BASE,
      toolName: 'read_file',
      toolCallId: 'tc-2',
      result: 'file contents',
      success: true,
    } satisfies ToolCompleted);

    expect(cb).toHaveBeenCalledOnce();
    const event = cb.mock.calls[0][0] as HookEventData;
    expect(event.type).toBe('PostToolUse');
    expect(event.payload).toMatchObject({ toolName: 'read_file', success: true });
  });

  // -------------------------------------------------------------------------
  // Notification → agent.message
  // -------------------------------------------------------------------------

  it('invokes Notification callback when agent.message fires', async () => {
    const cb = vi.fn<HookCallback>();
    const cleanup = registerHooks(MakaioBus, SESSION_ID, { Notification: cb });
    cleanups.push(cleanup);

    await MakaioBus.emit(AgentSubjects.message, {
      ...BASE,
      content: 'Hello from agent',
    });

    expect(cb).toHaveBeenCalledOnce();
    const event = cb.mock.calls[0][0] as HookEventData;
    expect(event.type).toBe('Notification');
    expect(event.payload).toMatchObject({ content: 'Hello from agent' });
  });

  // -------------------------------------------------------------------------
  // Array of callbacks
  // -------------------------------------------------------------------------

  it('invokes all callbacks in an array for the same hook event', async () => {
    const cb1 = vi.fn<HookCallback>();
    const cb2 = vi.fn<HookCallback>();
    const cleanup = registerHooks(MakaioBus, SESSION_ID, {
      SessionStart: [cb1, cb2],
    });
    cleanups.push(cleanup);

    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE,
      model: 'sonnet',
      cwd: '/tmp',
    } satisfies AgentStarted);

    expect(cb1).toHaveBeenCalledOnce();
    expect(cb2).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Cleanup / unsubscribe
  // -------------------------------------------------------------------------

  it('cleanup function removes all registered subscriptions', async () => {
    const cb = vi.fn<HookCallback>();
    const cleanup = registerHooks(MakaioBus, SESSION_ID, { SessionStart: cb });

    cleanup();

    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE,
      model: 'sonnet',
      cwd: '/tmp',
    } satisfies AgentStarted);

    expect(cb).not.toHaveBeenCalled();
  });

  it('cleanup is idempotent — calling it twice does not throw', () => {
    const cb = vi.fn<HookCallback>();
    const cleanup = registerHooks(MakaioBus, SESSION_ID, { SessionStart: cb });
    expect(() => {
      cleanup();
      cleanup();
    }).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Unknown / future hook names
  // -------------------------------------------------------------------------

  it('silently ignores unknown hook event names', () => {
    // SubagentStart / SubagentStop are the known non-available SDK hooks.
    // Any arbitrary unknown key must also be silently ignored.
    const noopCb: HookCallback = () => undefined;
    expect(() => {
      const cleanup = registerHooks(MakaioBus, SESSION_ID, {
        SubagentStart: noopCb,
        SubagentStop: noopCb,
        UnknownFutureHook: noopCb,
      });
      cleanups.push(cleanup);
    }).not.toThrow();
  });

  it('does not treat Object prototype names as supported hook events', () => {
    const noopCb: HookCallback = () => undefined;

    expect(() => {
      const cleanup = registerHooks(MakaioBus, SESSION_ID, {
        toString: noopCb,
      });
      cleanups.push(cleanup);
    }).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Async callbacks
  // -------------------------------------------------------------------------

  it('supports async hook callbacks', async () => {
    const results: string[] = [];
    const asyncCb: HookCallback = async (event) => {
      await Promise.resolve();
      results.push(event.type);
    };
    const cleanup = registerHooks(MakaioBus, SESSION_ID, { SessionStart: asyncCb });
    cleanups.push(cleanup);

    await MakaioBus.emit(AgentSubjects.started, {
      ...BASE,
      model: 'sonnet',
      cwd: '/tmp',
    } satisfies AgentStarted);

    // Give the microtask queue a tick to resolve the async callback.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(results).toContain('SessionStart');
  });

  // -------------------------------------------------------------------------
  // HookEventData shape
  // -------------------------------------------------------------------------

  it('provides correct HookEventData shape to callbacks', async () => {
    let received: HookEventData | undefined;
    const cb: HookCallback = (event) => {
      received = event;
    };
    const cleanup = registerHooks(MakaioBus, SESSION_ID, { PreToolUse: cb });
    cleanups.push(cleanup);

    await MakaioBus.emit(AgentSubjects.tool.use, {
      ...BASE,
      toolName: 'bash',
      toolCallId: 'tc-shape',
    });

    expect(received).toBeDefined();
    expect(received!.type).toBe('PreToolUse');
    expect(received!.sessionId).toBe(SESSION_ID);
    expect(received!.agentId).toBe(AGENT_ID);
    expect(typeof received!.payload).toBe('object');
  });
});
