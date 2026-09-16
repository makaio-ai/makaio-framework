/**
 * Extended adapter-managed gate tests: compaction/clear start-modes and TOCTOU
 * ownership snapshot. Kept in a sibling file because the primary test file
 * exceeds the 800-line project limit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBusInstance, type IMakaioBus } from '@makaio/bus-core';
import { ClientSubjects } from '@makaio/subsystem-client';
import { type ClientRuntimeStarted } from '@makaio/contracts/client';
import { ClaudeCodeClientService } from '../claude-code-client-service.js';
import { ClaudeCodeClientSubjects } from '../namespace.js';
import { CLAUDE_CODE_HOOK_SESSION_START, CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT } from '../schemas.js';

const RECEIVED_AT = 1_713_795_200_000;
const SESSION_ID = 'sess-gate-ext-001';

describe('ClaudeCodeClientService — adapter-managed gate (compaction/clear/TOCTOU)', () => {
  let bus: IMakaioBus;
  let service: ClaudeCodeClientService;

  beforeEach(async () => {
    bus = createBusInstance();
    service = new ClaudeCodeClientService(bus);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
  });

  function emitRuntimeStarted(overrides: Partial<ClientRuntimeStarted> = {}): Promise<void> {
    return bus.emit(ClientSubjects.runtime.started, {
      clientRuntimeId: 'rt-gate-default',
      clientId: 'claude-code',
      status: 'started',
      source: { layer: 'adapter', producer: 'claude-agent-sdk' },
      observedAt: RECEIVED_AT,
      adapterSessionId: SESSION_ID,
      ...overrides,
    });
  }

  // ---------------------------------------------------------------------------
  // Fix 1: compaction and clear starts pass the gate for managed sessions
  // ---------------------------------------------------------------------------

  it('forwards session.started with startMode "compact" for a managed session', async () => {
    await emitRuntimeStarted({ clientRuntimeId: 'rt-compact-1' });

    const received: unknown[] = [];
    const cleanup = bus.on(ClientSubjects.session.started, ({ payload }) => {
      received.push(payload);
    });

    // SessionStart with source 'compact' → normalizer sets startMode: 'compact'
    await bus.emit(ClaudeCodeClientSubjects.hook.received, {
      eventName: CLAUDE_CODE_HOOK_SESSION_START,
      receivedAt: RECEIVED_AT,
      payload: { session_id: SESSION_ID, source: 'compact' },
    });

    cleanup();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      adapterSessionId: SESSION_ID,
      startMode: 'compact',
    });
  });

  it('forwards session.started with startMode "clear" for a managed session', async () => {
    await emitRuntimeStarted({ clientRuntimeId: 'rt-clear-1' });

    const received: unknown[] = [];
    const cleanup = bus.on(ClientSubjects.session.started, ({ payload }) => {
      received.push(payload);
    });

    // SessionStart with source 'clear' → normalizer sets startMode: 'clear'
    await bus.emit(ClaudeCodeClientSubjects.hook.received, {
      eventName: CLAUDE_CODE_HOOK_SESSION_START,
      receivedAt: RECEIVED_AT,
      payload: { session_id: SESSION_ID, source: 'clear' },
    });

    cleanup();

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      adapterSessionId: SESSION_ID,
      startMode: 'clear',
    });
  });

  it('still suppresses session.started with source "startup" for a managed session', async () => {
    await emitRuntimeStarted({ clientRuntimeId: 'rt-startup-1' });

    const received: unknown[] = [];
    const cleanup = bus.on(ClientSubjects.session.started, ({ payload }) => {
      received.push(payload);
    });

    // SessionStart with source 'startup' → normalizer sets startMode: 'fresh'
    await bus.emit(ClaudeCodeClientSubjects.hook.received, {
      eventName: CLAUDE_CODE_HOOK_SESSION_START,
      receivedAt: RECEIVED_AT,
      payload: { session_id: SESSION_ID, source: 'startup' },
    });

    cleanup();

    // The adapter already emitted session.started for this session; the hook
    // duplicate must remain suppressed.
    expect(received).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Fix 2: TOCTOU — ownership snapshot taken before first emit
  // ---------------------------------------------------------------------------

  it('forwards both turn.started and userPrompt.submitted when adapter session is registered mid-emit', async () => {
    // The session is NOT yet managed when the hook arrives.
    const turnStartedEvents: unknown[] = [];
    const userPromptEvents: unknown[] = [];

    const cleanupTurn = bus.on(ClientSubjects.session.turn.started, ({ payload }) => {
      turnStartedEvents.push(payload);
      // From inside the turn.started handler, register the adapter session.
      // Without the TOCTOU fix this would cause userPrompt.submitted to be
      // suppressed even though it was already "in flight" from the same raw hook.
      void bus.emit(ClientSubjects.runtime.started, {
        clientRuntimeId: 'rt-toctou-1',
        clientId: 'claude-code',
        status: 'started',
        source: { layer: 'adapter', producer: 'claude-agent-sdk' },
        observedAt: RECEIVED_AT,
        adapterSessionId: SESSION_ID,
      });
    });

    const cleanupPrompt = bus.on(ClientSubjects.session.userPrompt.submitted, ({ payload }) => {
      userPromptEvents.push(payload);
    });

    // UserPromptSubmit normalizes into turn.started + userPrompt.submitted.
    await bus.emit(ClaudeCodeClientSubjects.hook.received, {
      eventName: CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT,
      receivedAt: RECEIVED_AT,
      payload: { session_id: SESSION_ID, prompt: 'Hello world' },
    });

    cleanupTurn();
    cleanupPrompt();

    // Both events must have been forwarded: ownership was evaluated ONCE before
    // the first emit, so the mid-emit runtime.started does not retroactively
    // suppress the second event.
    expect(turnStartedEvents).toHaveLength(1);
    expect(userPromptEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Fix 1: batch isolation — throwing subscriber does not abort remaining events
// ---------------------------------------------------------------------------

describe('ClaudeCodeClientService — batch isolation (throwing subscriber)', () => {
  let bus: IMakaioBus;
  let service: ClaudeCodeClientService;

  beforeEach(async () => {
    bus = createBusInstance();
    service = new ClaudeCodeClientService(bus);
    await service.init();
  });

  afterEach(async () => {
    await service.destroy();
  });

  it('a throwing turn.started subscriber does not prevent userPrompt.submitted for an unmanaged session', async () => {
    // Unmanaged session: no adapter runtime.started emitted beforehand.
    const promptReceived: unknown[] = [];

    const unsubThrowing = bus.on(ClientSubjects.session.turn.started, () => {
      throw new Error('intentional turn.started error');
    });
    const unsubPrompt = bus.on(ClientSubjects.session.userPrompt.submitted, (ctx: { payload: unknown }) => {
      promptReceived.push(ctx.payload);
    });

    // The service must forward userPrompt.submitted even when the turn.started
    // subscriber throws.  The first error is re-thrown after the loop so callers
    // still observe the failure.  This mirrors the Codex service contract.
    await expect(
      bus.emit(ClaudeCodeClientSubjects.hook.received, {
        eventName: CLAUDE_CODE_HOOK_USER_PROMPT_SUBMIT,
        receivedAt: RECEIVED_AT,
        payload: { session_id: 'sess-throw-unmanaged', prompt: 'batch isolation test' },
      }),
    ).rejects.toThrow('intentional turn.started error');

    unsubThrowing();
    unsubPrompt();

    // userPrompt.submitted must have been emitted despite the throwing turn.started.
    expect(promptReceived).toHaveLength(1);
  });
});
