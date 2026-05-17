import { describe, it, expect, vi } from 'vitest';
import type { RawClientHookPayload } from '@makaio/clients-core';
import { createHookEventRouter, type HookEventCallbacks } from '../utils/hook-event-router.js';

function makeRaw(eventName: string, payload: Record<string, unknown>): RawClientHookPayload {
  return { eventName, receivedAt: Date.now(), payload };
}

function makeCallbacks(): HookEventCallbacks {
  return {
    onSessionStart: vi.fn<HookEventCallbacks['onSessionStart']>(),
    onUserPromptSubmit: vi.fn<HookEventCallbacks['onUserPromptSubmit']>(),
    onPreToolUse: vi.fn<HookEventCallbacks['onPreToolUse']>(),
    onPostToolUse: vi.fn<HookEventCallbacks['onPostToolUse']>(),
    onStop: vi.fn<HookEventCallbacks['onStop']>(),
  };
}

describe('createHookEventRouter', () => {
  const SESSION_ID = 'test-session-abc';

  it('dispatches SessionStart with session_id and model', () => {
    const cb = makeCallbacks();
    const router = createHookEventRouter(() => undefined, cb);
    router(makeRaw('SessionStart', { session_id: SESSION_ID, model: 'claude-sonnet-4-5-20250514' }));

    expect(cb.onSessionStart).toHaveBeenCalledWith(SESSION_ID, 'claude-sonnet-4-5-20250514');
  });

  it('ignores SessionStart for a different expected session', () => {
    const cb = makeCallbacks();
    const router = createHookEventRouter(() => 'expected-session', cb);
    router(makeRaw('SessionStart', { session_id: SESSION_ID, model: 'opus' }));

    expect(cb.onSessionStart).not.toHaveBeenCalled();
  });

  it('dispatches UserPromptSubmit for matching session', () => {
    const cb = makeCallbacks();
    const router = createHookEventRouter(() => SESSION_ID, cb);
    router(makeRaw('UserPromptSubmit', { session_id: SESSION_ID, prompt: 'hello' }));

    expect(cb.onUserPromptSubmit).toHaveBeenCalledWith(SESSION_ID);
  });

  it('dispatches PreToolUse with tool details', () => {
    const cb = makeCallbacks();
    const router = createHookEventRouter(() => SESSION_ID, cb);
    router(
      makeRaw('PreToolUse', {
        session_id: SESSION_ID,
        tool_name: 'Bash',
        tool_use_id: 'tu_123',
        tool_input: { command: 'ls' },
      }),
    );

    expect(cb.onPreToolUse).toHaveBeenCalledWith(SESSION_ID, 'Bash', 'tu_123', { command: 'ls' });
  });

  it('dispatches PostToolUse with tool result', () => {
    const cb = makeCallbacks();
    const router = createHookEventRouter(() => SESSION_ID, cb);
    router(
      makeRaw('PostToolUse', {
        session_id: SESSION_ID,
        tool_name: 'Bash',
        tool_use_id: 'tu_123',
        tool_result: 'file1.ts\nfile2.ts',
      }),
    );

    expect(cb.onPostToolUse).toHaveBeenCalledWith(SESSION_ID, 'Bash', 'tu_123', 'file1.ts\nfile2.ts');
  });

  it('dispatches Stop with last_assistant_message', () => {
    const cb = makeCallbacks();
    const router = createHookEventRouter(() => SESSION_ID, cb);
    router(makeRaw('Stop', { session_id: SESSION_ID, last_assistant_message: 'Done!' }));

    expect(cb.onStop).toHaveBeenCalledWith(SESSION_ID, 'Done!');
  });

  it('ignores events from other session IDs', () => {
    const cb = makeCallbacks();
    const router = createHookEventRouter(() => SESSION_ID, cb);
    router(makeRaw('Stop', { session_id: 'other-session', last_assistant_message: 'nope' }));

    expect(cb.onStop).not.toHaveBeenCalled();
  });

  it('ignores events with no session_id (except SessionStart)', () => {
    const cb = makeCallbacks();
    const router = createHookEventRouter(() => SESSION_ID, cb);
    router(makeRaw('Stop', {}));

    expect(cb.onStop).not.toHaveBeenCalled();
  });

  it('ignores SessionStart with no session_id', () => {
    const cb = makeCallbacks();
    const router = createHookEventRouter(() => undefined, cb);
    router(makeRaw('SessionStart', { model: 'opus' }));

    expect(cb.onSessionStart).not.toHaveBeenCalled();
  });

  it('ignores unknown event names', () => {
    const cb = makeCallbacks();
    const router = createHookEventRouter(() => SESSION_ID, cb);
    router(makeRaw('UnknownEvent', { session_id: SESSION_ID }));

    expect(cb.onSessionStart).not.toHaveBeenCalled();
    expect(cb.onUserPromptSubmit).not.toHaveBeenCalled();
    expect(cb.onPreToolUse).not.toHaveBeenCalled();
    expect(cb.onPostToolUse).not.toHaveBeenCalled();
    expect(cb.onStop).not.toHaveBeenCalled();
  });

  it('passes all events when expectedSessionId is undefined', () => {
    const cb = makeCallbacks();
    const router = createHookEventRouter(() => undefined, cb);
    router(makeRaw('Stop', { session_id: 'any-session', last_assistant_message: 'yep' }));

    expect(cb.onStop).toHaveBeenCalledWith('any-session', 'yep');
  });

  it('supports dynamic session ID binding via getter', () => {
    const cb = makeCallbacks();
    const state = { sessionId: undefined as string | undefined };
    const router = createHookEventRouter(() => state.sessionId, cb);

    router(makeRaw('Stop', { session_id: 'session-a', last_assistant_message: 'a' }));
    expect(cb.onStop).toHaveBeenCalledWith('session-a', 'a');

    state.sessionId = 'session-b';
    router(makeRaw('Stop', { session_id: 'session-a', last_assistant_message: 'ignored' }));
    expect(cb.onStop).toHaveBeenCalledTimes(1);

    router(makeRaw('Stop', { session_id: 'session-b', last_assistant_message: 'b' }));
    expect(cb.onStop).toHaveBeenCalledTimes(2);
    expect(cb.onStop).toHaveBeenLastCalledWith('session-b', 'b');
  });

  it('handles missing optional fields with empty string defaults', () => {
    const cb = makeCallbacks();
    const router = createHookEventRouter(() => SESSION_ID, cb);

    router(makeRaw('PreToolUse', { session_id: SESSION_ID }));
    expect(cb.onPreToolUse).toHaveBeenCalledWith(SESSION_ID, '', '', undefined);

    router(makeRaw('Stop', { session_id: SESSION_ID }));
    expect(cb.onStop).toHaveBeenCalledWith(SESSION_ID, '');
  });

  it('awaits async hook callbacks before resolving', async () => {
    let completed = false;
    const cb = makeCallbacks();
    cb.onStop = vi.fn(async () => {
      await Promise.resolve();
      completed = true;
    });
    const router = createHookEventRouter(() => SESSION_ID, cb);

    await router(makeRaw('Stop', { session_id: SESSION_ID, last_assistant_message: 'Done!' }));

    expect(completed).toBe(true);
  });
});
