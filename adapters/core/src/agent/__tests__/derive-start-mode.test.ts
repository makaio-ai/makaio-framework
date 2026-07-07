import { describe, expect, it } from 'vitest';
import { AgentTurnExecutor } from '../agent-turn-executor.js';
import type { SessionContext } from '@makaio/contracts';

describe('AgentTurnExecutor.deriveStartMode', () => {
  // -------------------------------------------------------------------------
  // fresh — no session context (no resume target) or first turn
  // -------------------------------------------------------------------------

  it('returns "fresh" when no sessionContext and no resume target', () => {
    expect(AgentTurnExecutor.deriveStartMode(undefined, false)).toBe('fresh');
  });

  it('returns "fresh" when isFirstTurn is true', () => {
    const ctx: SessionContext = { isFirstTurn: true };
    expect(AgentTurnExecutor.deriveStartMode(ctx, false)).toBe('fresh');
  });

  it('returns "rotation" when sessionContext present but isFirstTurn omitted', () => {
    // isFirstTurn omitted entirely — sessionContext is truthy, isFirstTurn is
    // undefined (falsy), so the guard `!sessionContext || sessionContext.isFirstTurn`
    // does NOT match. Falls through to 'rotation': having a session context
    // without isFirstTurn set means the orchestrator considers this a
    // continuation turn.
    const ctx: SessionContext = {};
    expect(AgentTurnExecutor.deriveStartMode(ctx, false)).toBe('rotation');
  });

  // -------------------------------------------------------------------------
  // fork — nativeFork takes highest priority
  // -------------------------------------------------------------------------

  it('returns "fork" when nativeFork directive is present', () => {
    const ctx: SessionContext = {
      isFirstTurn: false,
      nativeFork: {
        sourceSessionId: 'parent-1',
        sourceAdapterSessionId: 'as-parent-1',
      },
    };
    expect(AgentTurnExecutor.deriveStartMode(ctx, false)).toBe('fork');
  });

  it('returns "fork" even when isFirstTurn is true (fork has highest priority)', () => {
    const ctx: SessionContext = {
      isFirstTurn: true,
      nativeFork: {
        sourceSessionId: 'parent-1',
        sourceAdapterSessionId: 'as-parent-1',
      },
    };
    expect(AgentTurnExecutor.deriveStartMode(ctx, false)).toBe('fork');
  });

  it('returns "fork" even when useNativeResume is true (fork has highest priority)', () => {
    const ctx: SessionContext = {
      isFirstTurn: false,
      nativeFork: {
        sourceSessionId: 'parent-1',
        sourceAdapterSessionId: 'as-parent-1',
      },
    };
    expect(AgentTurnExecutor.deriveStartMode(ctx, true)).toBe('fork');
  });

  it('returns "fork" when both nativeFork and useNativeResume are present', () => {
    const ctx: SessionContext = {
      nativeFork: {
        sourceSessionId: 'parent-1',
        sourceAdapterSessionId: 'as-parent-1',
      },
    };
    expect(AgentTurnExecutor.deriveStartMode(ctx, true)).toBe('fork');
  });

  // -------------------------------------------------------------------------
  // fresh — no session context + no resume target (P2a: sessionless/ephemeral)
  // -------------------------------------------------------------------------

  it('returns "fresh" when no sessionContext even if useNativeResume is true (no resume target)', () => {
    // A native-resume-capable adapter with no session context AND no resume
    // target (sessionless or ephemeral agent) must still start fresh — there
    // is nothing to resume.
    expect(AgentTurnExecutor.deriveStartMode(undefined, true)).toBe('fresh');
  });

  it('returns "fresh" when no sessionContext, no resume target, useNativeResume true', () => {
    // Explicit hasResumeTarget=false: same as omitting it.
    expect(AgentTurnExecutor.deriveStartMode(undefined, true, false)).toBe('fresh');
  });

  // -------------------------------------------------------------------------
  // resume — native attach (resume target, no sessionContext)
  // -------------------------------------------------------------------------

  it('returns "resume" for native attach: resume target present, no sessionContext', () => {
    // Native attach builds startAgent with resumeAdapterSessionId but no
    // sessionContext. The concrete resume target distinguishes this from a
    // sessionless/ephemeral start.
    expect(AgentTurnExecutor.deriveStartMode(undefined, false, true)).toBe('resume');
  });

  it('returns "resume" for native attach even when useNativeResume is true', () => {
    // The resume target fires before useNativeResume — both signals agree on
    // 'resume' but the target-based rule takes precedence in the absent-context
    // branch.
    expect(AgentTurnExecutor.deriveStartMode(undefined, true, true)).toBe('resume');
  });

  // -------------------------------------------------------------------------
  // resume — context-based useNativeResume without fork
  // -------------------------------------------------------------------------

  it('returns "resume" when useNativeResume is true and no nativeFork', () => {
    const ctx: SessionContext = { isFirstTurn: false };
    expect(AgentTurnExecutor.deriveStartMode(ctx, true)).toBe('resume');
  });

  it('returns "resume" when context present with useNativeResume, hasResumeTarget ignored', () => {
    // When sessionContext IS present, hasResumeTarget has no effect — the
    // context-based rules (4-6) take over.
    const ctx: SessionContext = { isFirstTurn: false };
    expect(AgentTurnExecutor.deriveStartMode(ctx, true, true)).toBe('resume');
  });

  // -------------------------------------------------------------------------
  // rotation — continuation turn without native resume or fork
  // -------------------------------------------------------------------------

  it('returns "rotation" when isFirstTurn is false, useNativeResume false, no fork', () => {
    const ctx: SessionContext = { isFirstTurn: false };
    expect(AgentTurnExecutor.deriveStartMode(ctx, false)).toBe('rotation');
  });

  it('returns "rotation" for turn-2+ with context even when hasResumeTarget is true', () => {
    // Turn 2+ with context: hasResumeTarget has no effect. The session layer
    // supplies context with isFirstTurn=false, useNativeResume=false → rotation.
    const ctx: SessionContext = { isFirstTurn: false };
    expect(AgentTurnExecutor.deriveStartMode(ctx, false, true)).toBe('rotation');
  });
});
