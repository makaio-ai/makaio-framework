import type {
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUsage,
} from './types.js';

/** Mutable accumulator state shared across a single query lifecycle. */
export interface AccumulatorState {
  usage: SDKUsage;
  totalCost: number;
  turnCount: number;
  lastContextLevel: string | null;
  startTime: number;
}

/**
 * Create a fresh accumulator state for a query.
 * @returns Mutable accumulator state.
 */
export function createAccumulatorState(): AccumulatorState {
  return {
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    totalCost: 0,
    turnCount: 0,
    lastContextLevel: null,
    startTime: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Inline helpers — kept as expressions to avoid triggering JSDoc lint on
// trivial private functions that are only called from the dispatcher below.
// ---------------------------------------------------------------------------

const toSystemInit = (payload: Record<string, unknown>, sessionId: string, uuid: string): SDKSystemMessage => ({
  type: 'system',
  subtype: 'init',
  model: String(payload.model ?? ''),
  cwd: String(payload.cwd ?? ''),
  tools: [],
  session_id: sessionId,
  uuid,
});

const toAssistant = (
  content: SDKAssistantMessage['message']['content'],
  sessionId: string,
  uuid: string,
): SDKAssistantMessage => ({
  type: 'assistant',
  message: { role: 'assistant', content },
  session_id: sessionId,
  uuid,
});

const toResult = (
  payload: Record<string, unknown>,
  sessionId: string,
  uuid: string,
  state: AccumulatorState,
): SDKResultMessage => {
  const isError = payload.outcome === 'error';
  state.turnCount++;
  return {
    type: 'result',
    subtype: isError ? 'error' : 'success',
    duration_ms: Date.now() - state.startTime,
    is_error: isError,
    num_turns: state.turnCount,
    result: String(isError ? (payload.error ?? '') : (payload.message ?? '')),
    total_cost_usd: state.totalCost,
    usage: { ...state.usage },
    session_id: sessionId,
    uuid,
  };
};

const VALID_COMPACT_LEVELS = new Set(['ok', 'warn', 'critical']);

const toCompactBoundary = (
  payload: Record<string, unknown>,
  sessionId: string,
  uuid: string,
  state: AccumulatorState,
): SDKCompactBoundaryMessage | null => {
  const raw = String(payload.level ?? 'ok');
  const level = VALID_COMPACT_LEVELS.has(raw) ? (raw as 'ok' | 'warn' | 'critical') : 'ok';
  if (level === state.lastContextLevel) return null;
  state.lastContextLevel = level;
  return {
    type: 'system',
    subtype: 'compact',
    level,
    percentage: Number(payload.percentage ?? 0),
    session_id: sessionId,
    uuid,
  };
};

const accumulateUsage = (payload: Record<string, unknown>, state: AccumulatorState): null => {
  state.usage = {
    input_tokens: state.usage.input_tokens + Number(payload.inputTokens ?? 0),
    output_tokens: state.usage.output_tokens + Number(payload.outputTokens ?? 0),
    cache_read_input_tokens: state.usage.cache_read_input_tokens + Number(payload.inputCachedTokens ?? 0),
    cache_creation_input_tokens: state.usage.cache_creation_input_tokens + Number(payload.cacheWriteTokens ?? 0),
  };
  state.totalCost += Number(payload.cost ?? 0);
  return null;
};

// ---------------------------------------------------------------------------
// Stateless subject to SDKMessage mappers (no AccumulatorState dependency).
// Keyed by the wire subject string; each mapper is called with (payload, sid, uuid).
// ---------------------------------------------------------------------------

type StatelessMapper = (payload: Record<string, unknown>, sessionId: string, uuid: string) => SDKMessage;

const STATELESS_MAPPERS: ReadonlyMap<string, StatelessMapper> = new Map<string, StatelessMapper>([
  ['agent.started', toSystemInit],
  ['agent.message_delta', (p, sid, id) => toAssistant([{ type: 'text', text: String(p.text ?? '') }], sid, id)],
  [
    'agent.reasoning_delta',
    (p, sid, id) => toAssistant([{ type: 'thinking', thinking: String(p.content ?? '') }], sid, id),
  ],
  ['agent.message', (p, sid, id) => toAssistant([{ type: 'text', text: String(p.content ?? '') }], sid, id)],
  ['agent.reasoning', (p, sid, id) => toAssistant([{ type: 'thinking', thinking: String(p.content ?? '') }], sid, id)],
  [
    'agent.tool.use',
    (p, sid, id) =>
      toAssistant(
        [
          {
            type: 'tool_use',
            name: String(p.toolName ?? ''),
            id: String(p.toolCallId ?? ''),
            input: (p.args as Record<string, unknown>) ?? {},
          },
        ],
        sid,
        id,
      ),
  ],
  [
    'agent.tool.output',
    (p, sid, id) =>
      toAssistant([{ type: 'tool_result', content: String(p.output ?? ''), id: String(p.toolCallId ?? '') }], sid, id),
  ],
  [
    'agent.tool.completed',
    (p, sid, id) =>
      toAssistant([{ type: 'tool_result', content: String(p.result ?? ''), id: String(p.toolCallId ?? '') }], sid, id),
  ],
  // Step lifecycle events carry a lightweight empty-text assistant message so
  // SDK consumers can observe block boundaries without a separate message type.
  ['agent.step.started', (_p, sid, id) => toAssistant([{ type: 'text', text: '' }], sid, id)],
  ['agent.step.finished', (_p, sid, id) => toAssistant([{ type: 'text', text: '' }], sid, id)],
]);

/**
 * Map a bus event to an SDK message, or null if the event should be accumulated.
 * @param subject - The wire subject string (e.g. 'agent.started').
 * @param payload - The bus event payload.
 * @param state - Mutable accumulator for usage and context window dedup.
 * @returns An SDKMessage to yield, or null to skip.
 */
export function mapBusEventToSdkMessage(
  subject: string,
  payload: Record<string, unknown>,
  state: AccumulatorState,
): SDKMessage | null {
  const sessionId = String(payload.sessionId ?? '');
  const uuid = String(payload.messageId ?? '');

  const stateless = STATELESS_MAPPERS.get(subject);
  if (stateless !== undefined) return stateless(payload, sessionId, uuid);

  if (subject === 'agent.complete') return toResult(payload, sessionId, uuid, state);
  if (subject === 'agent.contextWindow.updated') return toCompactBoundary(payload, sessionId, uuid, state);
  if (subject === 'agent.usage') return accumulateUsage(payload, state);
  return null;
}
