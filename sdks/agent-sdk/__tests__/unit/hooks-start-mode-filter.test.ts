import { afterEach, describe, expect, it, vi } from 'vitest';
import { MakaioBus } from '@makaio/bus-core';
import { AgentSubjects, START_MODES } from '@makaio/contracts';
import type { AgentStarted, AgentComplete } from '@makaio/contracts';
import { registerHooks } from '../../src/shared/hooks.js';
import type { HookCallback, HookEventData } from '../../src/shared/hooks.js';

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const SESSION_ID = 'session-start-mode-1';
const AGENT_ID = 'agent-start-mode-1';

const BASE = {
  agentId: AGENT_ID,
  adapterId: 'adapter-1',
  adapterName: 'test',
  adapterSessionId: 'as-1',
  sessionId: SESSION_ID,
} as const;

/**
 * Build a valid AgentStarted payload with the given startMode.
 * @param startMode - The start mode discriminator for the event.
 * @returns A valid AgentStarted payload.
 */
function startedPayload(startMode: AgentStarted['startMode']): AgentStarted {
  return {
    ...BASE,
    model: 'sonnet',
    cwd: '/tmp',
    startMode,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerHooks — SessionStart startMode filtering', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups.length = 0;
  });

  // -------------------------------------------------------------------------
  // Default filter: ['fresh', 'fork']
  // -------------------------------------------------------------------------

  it('default filter: SessionStart fires for startMode "fresh"', async () => {
    const cb = vi.fn<HookCallback>();
    const cleanup = registerHooks(MakaioBus, SESSION_ID, { SessionStart: cb });
    cleanups.push(cleanup);

    await MakaioBus.emit(AgentSubjects.started, startedPayload('fresh'));

    expect(cb).toHaveBeenCalledOnce();
    const event = cb.mock.calls[0][0] as HookEventData;
    expect(event.type).toBe('SessionStart');
  });

  it('default filter: SessionStart fires for startMode "fork"', async () => {
    const cb = vi.fn<HookCallback>();
    const cleanup = registerHooks(MakaioBus, SESSION_ID, { SessionStart: cb });
    cleanups.push(cleanup);

    await MakaioBus.emit(AgentSubjects.started, startedPayload('fork'));

    expect(cb).toHaveBeenCalledOnce();
    const event = cb.mock.calls[0][0] as HookEventData;
    expect(event.type).toBe('SessionStart');
  });

  it('default filter: SessionStart does NOT fire for startMode "resume"', async () => {
    const cb = vi.fn<HookCallback>();
    const cleanup = registerHooks(MakaioBus, SESSION_ID, { SessionStart: cb });
    cleanups.push(cleanup);

    await MakaioBus.emit(AgentSubjects.started, startedPayload('resume'));

    expect(cb).not.toHaveBeenCalled();
  });

  it('default filter: SessionStart does NOT fire for startMode "rotation"', async () => {
    const cb = vi.fn<HookCallback>();
    const cleanup = registerHooks(MakaioBus, SESSION_ID, { SessionStart: cb });
    cleanups.push(cleanup);

    await MakaioBus.emit(AgentSubjects.started, startedPayload('rotation'));

    expect(cb).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Custom filter: narrowed
  // -------------------------------------------------------------------------

  it('custom filter: startModes ["fresh"] only fires for "fresh", not "fork"', async () => {
    const cb = vi.fn<HookCallback>();
    const cleanup = registerHooks(MakaioBus, SESSION_ID, { SessionStart: cb }, { startModes: ['fresh'] });
    cleanups.push(cleanup);

    await MakaioBus.emit(AgentSubjects.started, startedPayload('fresh'));
    expect(cb).toHaveBeenCalledOnce();

    cb.mockClear();

    await MakaioBus.emit(AgentSubjects.started, startedPayload('fork'));
    expect(cb).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Custom filter: widened to all modes
  // -------------------------------------------------------------------------

  it('custom filter: START_MODES fires for all four modes', async () => {
    const cb = vi.fn<HookCallback>();
    const cleanup = registerHooks(MakaioBus, SESSION_ID, { SessionStart: cb }, { startModes: START_MODES });
    cleanups.push(cleanup);

    for (const mode of START_MODES) {
      cb.mockClear();
      await MakaioBus.emit(AgentSubjects.started, startedPayload(mode));
      expect(cb).toHaveBeenCalledOnce();
    }
  });

  // -------------------------------------------------------------------------
  // Non-SessionStart hooks are unaffected
  // -------------------------------------------------------------------------

  it('non-SessionStart hooks are unaffected by startModes option', async () => {
    const cbEnd = vi.fn<HookCallback>();
    const cleanup = registerHooks(
      MakaioBus,
      SESSION_ID,
      { SessionEnd: cbEnd },
      { startModes: ['fresh'] }, // should have no effect on SessionEnd
    );
    cleanups.push(cleanup);

    await MakaioBus.emit(AgentSubjects.complete, {
      ...BASE,
      messageId: 'msg-1',
      message: 'done',
      outcome: 'completed',
    } satisfies AgentComplete);

    expect(cbEnd).toHaveBeenCalledOnce();
    const event = cbEnd.mock.calls[0][0] as HookEventData;
    expect(event.type).toBe('SessionEnd');
  });
});
