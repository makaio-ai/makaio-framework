/**
 * Unit tests for QwenAcpTurn state machine.
 *
 * Covers:
 * - Initial state
 * - Full lifecycle transitions
 * - Multiple step cycles
 * - markTurnFinished shortcuts
 * - Text accumulation
 * - pause / resume / isPaused
 * - canAcceptImmediate
 * - Bus event emissions for every lifecycle event
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MessageHandle, type NormalizedMessageInput } from '@makaio/ai-adapters-core';
import { QwenAcpNamespace, QwenAcpSubjects } from '../namespaces/index.js';
import { QwenAcpTurn } from '../turn.js';
import type { QwenAcpBus, TurnStarted, TurnFinished, TurnStepStarted, TurnStepFinished } from '../namespaces/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal normalized message used to construct MessageHandle instances. */
const TEST_MESSAGE: NormalizedMessageInput = {
  role: 'user',
  message: 'Hello',
  blocks: [{ type: 'text', content: 'Hello' }],
};

/**
 * Create a fresh MessageHandle for each test to avoid cross-test state.
 * @returns A new MessageHandle in the 'queued' state
 */
function makeHandle(): MessageHandle {
  return new MessageHandle('msg-test', TEST_MESSAGE, 'enqueue');
}

/**
 * Construct a QwenAcpTurn wired to the provided bus.
 * @param bus - Scoped bus to emit lifecycle events onto
 * @returns A new QwenAcpTurn instance in the 'idle' state
 */
function makeTurn(bus: QwenAcpBus): QwenAcpTurn {
  return new QwenAcpTurn(makeHandle(), bus, 'adapter-1', 'qwen-acp', 'agent-1');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QwenAcpTurn', () => {
  let bus: QwenAcpBus;
  let turn: QwenAcpTurn;

  beforeEach(async () => {
    bus = await QwenAcpNamespace.scopedBus();
    turn = makeTurn(bus);
  });

  // -------------------------------------------------------------------------
  // 1. Initial state
  // -------------------------------------------------------------------------

  describe('initial state', () => {
    it('starts in idle state', () => {
      expect(turn.getState()).toBe('idle');
    });

    it('is not paused initially', () => {
      expect(turn.isPaused()).toBe(false);
    });

    it('can accept immediate messages initially', () => {
      expect(turn.canAcceptImmediate()).toBe(true);
    });

    it('returns empty accumulated text initially', () => {
      expect(turn.getAccumulatedText()).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Full lifecycle: idle → turn_started → step_started → step_finished → turn_finished
  // -------------------------------------------------------------------------

  describe('full lifecycle', () => {
    it('transitions through idle → turn_started → step_started → step_finished → turn_finished', async () => {
      expect(turn.getState()).toBe('idle');

      await turn.start();
      expect(turn.getState()).toBe('turn_started');

      await turn.markStepStarted();
      expect(turn.getState()).toBe('step_started');

      await turn.markStepFinished();
      expect(turn.getState()).toBe('step_finished');

      await turn.markTurnFinished();
      expect(turn.getState()).toBe('turn_finished');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Multiple steps
  // -------------------------------------------------------------------------

  describe('multiple steps', () => {
    it('allows step_started → step_finished → step_started → step_finished cycles', async () => {
      await turn.start();
      await turn.markStepStarted();
      expect(turn.getState()).toBe('step_started');

      await turn.markStepFinished();
      expect(turn.getState()).toBe('step_finished');

      // Second step cycle
      await turn.markStepStarted();
      expect(turn.getState()).toBe('step_started');

      await turn.markStepFinished();
      expect(turn.getState()).toBe('step_finished');
    });
  });

  // -------------------------------------------------------------------------
  // 4. markTurnFinished shortcuts
  // -------------------------------------------------------------------------

  describe('markTurnFinished', () => {
    it('transitions through step_finished automatically when called from step_started', async () => {
      await turn.start();
      await turn.markStepStarted();
      expect(turn.getState()).toBe('step_started');

      await turn.markTurnFinished();
      // step_started → step_finished → turn_finished
      expect(turn.getState()).toBe('turn_finished');
    });

    it('goes directly to turn_finished when called from turn_started', async () => {
      await turn.start();
      expect(turn.getState()).toBe('turn_started');

      await turn.markTurnFinished();
      expect(turn.getState()).toBe('turn_finished');
    });

    it('is idempotent: calling again from turn_finished stays at turn_finished', async () => {
      await turn.start();
      await turn.markTurnFinished();
      await turn.markTurnFinished();
      expect(turn.getState()).toBe('turn_finished');
    });
  });

  // -------------------------------------------------------------------------
  // 5. Text accumulation
  // -------------------------------------------------------------------------

  describe('text accumulation', () => {
    it('accumulates text chunks in order', () => {
      turn.appendText('Hello');
      turn.appendText(', ');
      turn.appendText('world!');
      expect(turn.getAccumulatedText()).toBe('Hello, world!');
    });

    it('returns empty string when no text has been appended', () => {
      expect(turn.getAccumulatedText()).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // 6. pause / resume / isPaused
  // -------------------------------------------------------------------------

  describe('pause and resume', () => {
    it('isPaused returns true after pause', async () => {
      await turn.start();
      await turn.pause();
      expect(turn.isPaused()).toBe(true);
    });

    it('isPaused returns false after resume', async () => {
      await turn.start();
      await turn.pause();
      await turn.resume();
      expect(turn.isPaused()).toBe(false);
    });

    it('pause returns turnEnded:false when turn is still active', async () => {
      await turn.start();
      const result = await turn.pause();
      expect(result.turnEnded).toBe(false);
      expect(result.stateBeforePause).toBe('turn_started');
    });

    it('pause returns turnEnded:true when turn is already finished', async () => {
      await turn.start();
      await turn.markTurnFinished();
      const result = await turn.pause();
      expect(result.turnEnded).toBe(true);
      expect(result.stateBeforePause).toBe('turn_finished');
    });
  });

  // -------------------------------------------------------------------------
  // 7. canAcceptImmediate
  // -------------------------------------------------------------------------

  describe('canAcceptImmediate', () => {
    it('returns true while turn is running', async () => {
      await turn.start();
      expect(turn.canAcceptImmediate()).toBe(true);
    });

    it('returns false after turn_finished', async () => {
      await turn.start();
      await turn.markTurnFinished();
      expect(turn.canAcceptImmediate()).toBe(false);
    });

    it('returns false while paused', async () => {
      await turn.start();
      await turn.pause();
      expect(turn.canAcceptImmediate()).toBe(false);
    });

    it('returns true again after resume (turn not finished)', async () => {
      await turn.start();
      await turn.pause();
      await turn.resume();
      expect(turn.canAcceptImmediate()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Bus event emissions
  // -------------------------------------------------------------------------

  describe('bus emissions', () => {
    it('emits turn_started when start() is called', async () => {
      const events: TurnStarted[] = [];
      bus.on(QwenAcpSubjects.turn_started, (ctx) => {
        events.push(ctx.payload);
      });

      await turn.start();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ agentId: 'agent-1' });
    });

    it('emits turn_step_started when markStepStarted() is called', async () => {
      const events: TurnStepStarted[] = [];
      bus.on(QwenAcpSubjects.turn_step_started, (ctx) => {
        events.push(ctx.payload);
      });

      await turn.start();
      await turn.markStepStarted();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ agentId: 'agent-1', stepType: 'text' });
    });

    it('emits turn_step_finished when markStepFinished() is called', async () => {
      const events: TurnStepFinished[] = [];
      bus.on(QwenAcpSubjects.turn_step_finished, (ctx) => {
        events.push(ctx.payload);
      });

      await turn.start();
      await turn.markStepStarted();
      await turn.markStepFinished();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ agentId: 'agent-1', stepType: 'text' });
    });

    it('emits tool_use step events when a tool step is started', async () => {
      const startedEvents: TurnStepStarted[] = [];
      const finishedEvents: TurnStepFinished[] = [];
      bus.on(QwenAcpSubjects.turn_step_started, (ctx) => {
        startedEvents.push(ctx.payload);
      });
      bus.on(QwenAcpSubjects.turn_step_finished, (ctx) => {
        finishedEvents.push(ctx.payload);
      });

      await turn.start();
      await turn.markStepStarted('tool_use');
      await turn.markStepFinished();

      expect(startedEvents).toHaveLength(1);
      expect(startedEvents[0]).toMatchObject({ agentId: 'agent-1', stepType: 'tool_use' });
      expect(finishedEvents).toHaveLength(1);
      expect(finishedEvents[0]).toMatchObject({ agentId: 'agent-1', stepType: 'tool_use' });
    });

    it('emits turn_finished when markTurnFinished() is called', async () => {
      const events: TurnFinished[] = [];
      bus.on(QwenAcpSubjects.turn_finished, (ctx) => {
        events.push(ctx.payload);
      });

      await turn.start();
      await turn.markTurnFinished();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ agentId: 'agent-1' });
    });

    it('emits turn_step_finished and turn_finished when markTurnFinished() is called from step_started', async () => {
      const stepFinishedEvents: TurnStepFinished[] = [];
      const turnFinishedEvents: TurnFinished[] = [];

      bus.on(QwenAcpSubjects.turn_step_finished, (ctx) => {
        stepFinishedEvents.push(ctx.payload);
      });
      bus.on(QwenAcpSubjects.turn_finished, (ctx) => {
        turnFinishedEvents.push(ctx.payload);
      });

      await turn.start();
      await turn.markStepStarted();
      await turn.markTurnFinished();

      expect(stepFinishedEvents).toHaveLength(1);
      expect(turnFinishedEvents).toHaveLength(1);
    });

    it('emits turn_state_changed for every transition', async () => {
      const stateChanges: Array<{ previousState: string; newState: string }> = [];
      bus.on(QwenAcpSubjects.turn_state_changed, (ctx) => {
        stateChanges.push({ previousState: ctx.payload.previousState, newState: ctx.payload.newState });
      });

      await turn.start();
      await turn.markStepStarted();
      await turn.markStepFinished();
      await turn.markTurnFinished();

      expect(stateChanges).toEqual([
        { previousState: 'idle', newState: 'turn_started' },
        { previousState: 'turn_started', newState: 'step_started' },
        { previousState: 'step_started', newState: 'step_finished' },
        { previousState: 'step_finished', newState: 'turn_finished' },
      ]);
    });

    it('emits step events for each step in a multi-step cycle', async () => {
      const stepStartedEvents: TurnStepStarted[] = [];
      const stepFinishedEvents: TurnStepFinished[] = [];

      bus.on(QwenAcpSubjects.turn_step_started, (ctx) => {
        stepStartedEvents.push(ctx.payload);
      });
      bus.on(QwenAcpSubjects.turn_step_finished, (ctx) => {
        stepFinishedEvents.push(ctx.payload);
      });

      await turn.start();

      await turn.markStepStarted();
      await turn.markStepFinished();
      await turn.markStepStarted();
      await turn.markStepFinished();

      expect(stepStartedEvents).toHaveLength(2);
      expect(stepFinishedEvents).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // 9. Message handle delegation
  // -------------------------------------------------------------------------

  describe('message handle', () => {
    it('returns the message handle passed to the constructor', () => {
      const handle = makeHandle();
      const localTurn = new QwenAcpTurn(handle, bus, 'adapter-1', 'qwen-acp', 'agent-1');
      expect(localTurn.getMessageHandle()).toBe(handle);
    });

    it('markAcknowledged delegates to the message handle', async () => {
      const handle = makeHandle();
      const localTurn = new QwenAcpTurn(handle, bus, 'adapter-1', 'qwen-acp', 'agent-1');

      localTurn.markAcknowledged();
      const acked = await handle.waitForAcknowledgment();
      expect(acked).toBe(true);
    });

    it('markCompleted delegates to the message handle', async () => {
      const handle = makeHandle();
      const localTurn = new QwenAcpTurn(handle, bus, 'adapter-1', 'qwen-acp', 'agent-1');

      localTurn.markCompleted({ outcome: 'completed' });
      const result = await handle.waitForCompletion();
      expect(result.outcome).toBe('completed');
    });
  });
});
