/* eslint-disable max-lines-per-function, complexity */
import type { ProceduralConnectorTurn } from '@makaio/ai-adapters-core';
import type { StreamSessionTurnState } from '@makaio/ai-adapters-stream-session';
import { CursorSdkSubjects } from './namespaces/index.js';
import type { CursorSdkBus } from './namespaces/index.js';

/** Minimal turn lifecycle surface required by Cursor event routing. */
type StepLifecycleTurn = Pick<
  ProceduralConnectorTurn<StreamSessionTurnState, CursorSdkBus>,
  'markStepStarted' | 'markStepFinished'
>;

/** Identity metadata auto-injected into every scoped bus emission. */
export interface BusMetadata {
  /** Agent ID for event filtering. */
  agentId: string;
  /** Adapter instance ID. */
  adapterId: string;
  /** Adapter name (e.g. 'cursor-sdk'). */
  adapterName: string;
}

/** Configuration for event routing handlers. */
export interface EventRoutingConfig {
  /** The scoped bus to emit events on. */
  bus: CursorSdkBus;
  /** Agent ID for event context. */
  agentId: string;
  /** Identity metadata merged into every emission. */
  metadata: BusMetadata;
  /** Makaio message that owns the current SDK run. */
  messageId: string;
}

/** State tracked across a single turn's delta events. */
export interface TurnEventState {
  /** Whether step_started has been emitted for the current step. */
  stepStarted: boolean;
  /** Accumulated text for text_complete emission (cleared per step). */
  accumulatedText: string;
  /** Total text accumulated across all steps in this turn (never cleared). */
  turnText: string;
  /** Accumulated thinking text for thinking_complete emission. */
  accumulatedThinking: string;
  /** Start time for duration tracking. */
  startTime: number;
}

/**
 * Create fresh turn event state for a new turn.
 * @returns Initial event state.
 */
export function createTurnEventState(): TurnEventState {
  return {
    stepStarted: false,
    accumulatedText: '',
    turnText: '',
    accumulatedThinking: '',
    startTime: Date.now(),
  };
}

/**
 * Emit a scoped bus event with auto-injected identity metadata.
 * @param bus - Scoped bus to emit on.
 * @param metadata - Identity fields to merge into every payload.
 * @param args - Subject and payload arguments for bus.emit().
 */
export function emitWithMetadata(
  bus: CursorSdkBus,
  metadata: BusMetadata,
  ...args: Parameters<CursorSdkBus['emit']>
): void {
  const [subject, payload] = args;
  void bus.emit(subject, { ...payload, ...metadata } as Parameters<CursorSdkBus['emit']>[1]);
}

/**
 * Mark a stream step as started without exposing rejected lifecycle promises.
 * @param turn - Active turn whose step lifecycle should advance.
 */
function markStepStarted(turn: StepLifecycleTurn): void {
  void turn.markStepStarted().catch((err: unknown) => {
    console.error('[CursorSdkEventRouting] turn.markStepStarted failed:', err);
  });
}

/**
 * Mark a stream step as finished without exposing rejected lifecycle promises.
 * @param turn - Active turn whose step lifecycle should advance.
 */
function markStepFinished(turn: StepLifecycleTurn): void {
  void turn.markStepFinished().catch((err: unknown) => {
    console.error('[CursorSdkEventRouting] turn.markStepFinished failed:', err);
  });
}

/**
 * Serialize shell output values without letting non-JSON payloads break routing.
 * @param value - Raw shell output update payload from Cursor SDK.
 * @returns String delta for the shell output subject.
 */
function stringifyShellOutput(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Flush accumulated text and thinking buffers as complete events.
 * @param bus - Scoped bus to emit on.
 * @param metadata - Identity metadata to inject.
 * @param state - Mutable turn event state containing the buffers.
 */
export function flushAccumulated(bus: CursorSdkBus, metadata: BusMetadata, state: TurnEventState): void {
  if (state.accumulatedText) {
    emitWithMetadata(bus, metadata, CursorSdkSubjects.text_complete, {
      eventType: 'text_complete',
      text: state.accumulatedText,
    });
    state.accumulatedText = '';
  }
  if (state.accumulatedThinking) {
    emitWithMetadata(bus, metadata, CursorSdkSubjects.thinking_complete, {
      eventType: 'thinking_complete',
      text: state.accumulatedThinking,
    });
    state.accumulatedThinking = '';
  }
}

/** Raw update payload shape from Cursor SDK's onDelta callback. */
type CursorUpdate = { type: string; [key: string]: unknown };

/**
 * Narrow an unknown value to a loose object for SDK payload inspection.
 * @param value - Unknown SDK payload fragment.
 * @returns True when the value can be inspected as a record.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Determine whether a completed Cursor tool call represents a failed execution.
 *
 * Cursor's SDK can report failure via explicit `isError`, top-level status, or
 * a nested result discriminant. Treat all of those as the same framework
 * `isError` signal so downstream tool telemetry remains truthful.
 * @param update - Raw Cursor tool-call-completed update.
 * @param toolCall - Parsed tool call payload from the update.
 * @returns True when the completed tool call failed.
 */
function isFailedToolCompletion(update: CursorUpdate, toolCall: Record<string, unknown> | undefined): boolean {
  if (update['isError'] === true || toolCall?.['isError'] === true) return true;
  if (update['status'] === 'error' || toolCall?.['status'] === 'error') return true;

  const result = toolCall?.['result'];
  return isRecord(result) && result['status'] === 'error';
}

/**
 * Route a single Cursor SDK update to the appropriate semantic bus subject.
 *
 * Separated from the outer handler to keep per-event logic isolated and
 * satisfy the per-function line limit.
 * @param bus - Scoped bus to emit events on.
 * @param metadata - Identity metadata to inject into every emission.
 * @param turn - Active turn for state transitions.
 * @param state - Mutable turn event state.
 * @param update - Raw update from Cursor SDK's onDelta callback.
 * @param messageId - Makaio message that owns the SDK update.
 */
function routeUpdate(
  bus: CursorSdkBus,
  metadata: BusMetadata,
  turn: StepLifecycleTurn,
  state: TurnEventState,
  update: CursorUpdate,
  messageId: string,
): void {
  switch (update.type) {
    case 'text-delta': {
      if (!state.stepStarted) {
        state.stepStarted = true;
        markStepStarted(turn);
      }
      const textDelta = (update.text as string) ?? '';
      state.accumulatedText += textDelta;
      state.turnText += textDelta;
      emitWithMetadata(bus, metadata, CursorSdkSubjects.text_delta, {
        eventType: 'text_delta',
        delta: textDelta,
      });
      break;
    }

    case 'thinking-delta': {
      if (!state.stepStarted) {
        state.stepStarted = true;
        markStepStarted(turn);
      }
      const thinkDelta = (update.text as string) ?? '';
      state.accumulatedThinking += thinkDelta;
      emitWithMetadata(bus, metadata, CursorSdkSubjects.thinking_delta, {
        eventType: 'thinking_delta',
        delta: thinkDelta,
      });
      break;
    }

    case 'thinking-completed':
      emitWithMetadata(bus, metadata, CursorSdkSubjects.thinking_complete, {
        eventType: 'thinking_complete',
        text: state.accumulatedThinking,
        durationMs: (update.thinkingDurationMs as number | undefined) ?? undefined,
      });
      state.accumulatedThinking = '';
      break;

    case 'tool-call-started': {
      const toolCall = update.toolCall as { type: string; args?: unknown } | undefined;
      emitWithMetadata(bus, metadata, CursorSdkSubjects.tool_started, {
        eventType: 'tool_started',
        messageId,
        toolName: toolCall?.type ?? 'unknown',
        toolCallId: (update.callId as string) ?? '',
        args: toolCall?.args,
      });
      break;
    }

    case 'tool-call-completed': {
      const completedCall = isRecord(update.toolCall) ? update.toolCall : undefined;
      emitWithMetadata(bus, metadata, CursorSdkSubjects.tool_completed, {
        eventType: 'tool_completed',
        messageId,
        toolName: typeof completedCall?.['type'] === 'string' ? completedCall['type'] : 'unknown',
        toolCallId: (update.callId as string) ?? '',
        result: completedCall?.['result'],
        isError: isFailedToolCompletion(update, completedCall),
      });
      break;
    }

    case 'shell-output-delta': {
      const raw = update.event;
      emitWithMetadata(bus, metadata, CursorSdkSubjects.shell_output_delta, {
        eventType: 'shell_output_delta',
        delta: stringifyShellOutput(raw),
      });
      break;
    }

    case 'summary-started':
      emitWithMetadata(bus, metadata, CursorSdkSubjects.summary_started, { eventType: 'summary_started' });
      break;

    case 'summary-completed':
      emitWithMetadata(bus, metadata, CursorSdkSubjects.summary_complete, {
        eventType: 'summary_complete',
        text: (update.summary as string) ?? '',
      });
      break;

    case 'turn-ended': {
      flushAccumulated(bus, metadata, state);
      if (update.usage && typeof update.usage === 'object') {
        emitWithMetadata(bus, metadata, CursorSdkSubjects.usage, {
          eventType: 'usage',
          usage: update.usage,
          agentId: metadata.agentId,
          adapterId: metadata.adapterId,
          adapterName: metadata.adapterName,
        });
      }
      break;
    }

    case 'status-changed':
      emitWithMetadata(bus, metadata, CursorSdkSubjects.status_changed, {
        eventType: 'status_changed',
        status: (update.status as string) ?? '',
        message: (update.message as string | undefined) ?? undefined,
      });
      break;
  }
}

/**
 * Create the onDelta callback for Cursor SDK's agent.send().
 *
 * Routes InteractionUpdate events to scoped bus subjects. Always emits the
 * raw `sdk.event` first for observability, then delegates to
 * {@link routeUpdate} for normalized semantic subject emission.
 * @param config - Event routing configuration.
 * @param turn - The active turn for state transitions.
 * @param state - Mutable turn event state.
 * @returns Callback function for SendOptions.onDelta.
 */
export function createDeltaHandler(
  config: EventRoutingConfig,
  turn: StepLifecycleTurn,
  state: TurnEventState,
): (event: { update: CursorUpdate }) => void {
  const { bus, messageId, metadata } = config;

  return ({ update }) => {
    // Always emit raw event first for observability
    emitWithMetadata(bus, metadata, CursorSdkSubjects.sdk.event, update);
    routeUpdate(bus, metadata, turn, state, update, messageId);
  };
}

/**
 * Create the onStep callback for Cursor SDK's agent.send().
 *
 * Called by the SDK when a step boundary is reached. Flushes any accumulated
 * text as a `text_complete` event, then transitions the turn to step_finished
 * and resets the stepStarted flag so the next content block correctly
 * transitions to step_started again.
 * @param config - Event routing configuration (bus and agentId).
 * @param turn - The active turn for state transitions.
 * @param state - Mutable turn event state.
 * @returns Callback function for SendOptions.onStep.
 */
export function createStepHandler(
  config: EventRoutingConfig,
  turn: StepLifecycleTurn,
  state: TurnEventState,
): (event: { step: unknown }) => void {
  const { bus, metadata } = config;
  return () => {
    if (state.stepStarted) {
      flushAccumulated(bus, metadata, state);
      markStepFinished(turn);
      state.stepStarted = false;
    }
  };
}
