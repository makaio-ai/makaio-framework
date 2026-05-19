import type {
  SDKAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSessionStateChangedMessage,
  SDKToolProgressMessage,
  SDKUUID,
  SDKSystemMessage,
  SDKToolResultMessage,
  SDKUsage,
} from './sdk-messages.js';

// ---------------------------------------------------------------------------
// Tool-name normalization: Makaio snake_case → Claude PascalCase.
//
// Consumers written for the Claude Agent SDK expect PascalCase tool names
// (Read, Bash, Edit, etc.) in tool_use content blocks. Makaio's framework
// tools use snake_case (read_file, shell_exec, etc.). This table normalizes
// at the SDK boundary so consumers see identical names regardless of backend.
// Unknown tool names (MCP tools, user-defined tools) pass through unchanged.
// ---------------------------------------------------------------------------

const TOOL_NAME_MAP: ReadonlyMap<string, string> = new Map([
  // Verified against live Claude Code sessions (JSONL transcripts, 2026-05-19).
  // Fixtures: __tests__/fixtures/claude-tool-use-blocks.json
  ['read_file', 'Read'],
  ['write_file', 'Write'],
  ['edit_file', 'Edit'],
  ['glob_files', 'Glob'],
  ['grep_files', 'Grep'],
  ['shell_exec', 'Bash'],
  ['shell_kill', 'TaskStop'],
  ['spawn_subagent', 'Agent'],
  ['send_to_subagent', 'SendMessage'],
]);

/**
 * Normalize a Makaio tool name to its Claude-compatible equivalent.
 * @param name - The raw tool name from the bus event.
 * @returns The Claude-compatible name, or the original if no mapping exists.
 */
const normalizeToolName = (name: string): string => TOOL_NAME_MAP.get(name) ?? name;

// ---------------------------------------------------------------------------
// Tool-input normalization: Makaio field names → Claude field names.
//
// Keyed by Makaio tool name (pre-normalization). Each entry maps old field
// names to new ones. Fields not listed pass through unchanged.
// Verified against live Claude Code sessions (JSONL transcripts, 2026-05-19).
// ---------------------------------------------------------------------------

const TOOL_INPUT_RENAMES: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map([
  ['read_file', new Map([['path', 'file_path']])],
  ['write_file', new Map([['path', 'file_path']])],
  ['edit_file', new Map([['path', 'file_path']])],
  ['glob_files', new Map([['cwd', 'path']])],
  ['shell_kill', new Map([['shellId', 'task_id']])],
  ['spawn_subagent', new Map([['task', 'prompt']])],
  [
    'send_to_subagent',
    new Map([
      ['subagentId', 'to'],
      ['content', 'message'],
    ]),
  ],
]);

/**
 * Rename input fields according to TOOL_INPUT_RENAMES for the given tool.
 * @param toolName - The Makaio tool name (pre-normalization).
 * @param input - The raw input object from the bus event.
 * @returns A new object with renamed fields, or the original if no renames apply.
 */
const normalizeToolInput = (toolName: string, input: Record<string, unknown>): Record<string, unknown> => {
  const renames = TOOL_INPUT_RENAMES.get(toolName);
  if (!renames) return input;

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    result[renames.get(key) ?? key] = value;
  }
  return result;
};

/**
 * Coerce a plain string to SDKUUID for use in outbound message shapes.
 *
 * Bus message IDs are expected to be RFC 4122 UUIDs at runtime. This function
 * documents that expectation without adding a runtime validation overhead.
 * @param s - The raw string identifier from the bus payload.
 * @returns The value branded as SDKUUID.
 */
const asUUID = (s: string): SDKUUID => s as SDKUUID;

/** Zero-valued SDKUsage sentinel used to initialise the accumulator. */
const EMPTY_USAGE: SDKUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  inference_geo: '',
  iterations: [],
  server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
  service_tier: 'standard',
  speed: 'standard',
};

/** Mutable accumulator state shared across a single query lifecycle. */
export interface AccumulatorState {
  usage: SDKUsage;
  totalCost: number;
  turnCount: number;
  startTime: number;
}

/**
 * Create a fresh accumulator state for a query.
 * @returns Mutable accumulator state.
 */
export function createAccumulatorState(): AccumulatorState {
  return {
    usage: { ...EMPTY_USAGE },
    totalCost: 0,
    turnCount: 0,
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
  apiKeySource: 'user',
  claude_code_version: '',
  cwd: String(payload.cwd ?? ''),
  model: String(payload.model ?? ''),
  tools: (payload.tools as string[] | undefined) ?? [],
  mcp_servers: (payload.mcpServers as { name: string; status: string }[] | undefined) ?? [],
  permissionMode: 'default',
  slash_commands: [],
  output_style: '',
  skills: [],
  plugins: [],
  session_id: sessionId,
  uuid,
});

const toAssistant = (
  content: SDKAssistantMessage['message']['content'],
  sessionId: string,
  uuid: string,
): SDKAssistantMessage => ({
  type: 'assistant',
  message: {
    id: uuid,
    type: 'message',
    role: 'assistant',
    model: '',
    content: [...content],
    stop_reason: null,
    stop_sequence: null,
    usage: { ...EMPTY_USAGE },
  },
  parent_tool_use_id: null,
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
  const shared = {
    type: 'result' as const,
    duration_ms: Date.now() - state.startTime,
    duration_api_ms: 0,
    is_error: isError,
    num_turns: state.turnCount,
    stop_reason: null,
    total_cost_usd: state.totalCost,
    usage: { ...state.usage },
    modelUsage: {},
    permission_denials: [],
    session_id: sessionId,
    uuid: asUUID(uuid),
  };
  if (isError) {
    return {
      ...shared,
      subtype: 'error_during_execution',
      errors: [String(payload.error ?? '')],
    };
  }
  return {
    ...shared,
    subtype: 'success',
    result: String(payload.message ?? ''),
  };
};

const toCompactBoundary = (
  payload: Record<string, unknown>,
  sessionId: string,
  uuid: string,
): SDKCompactBoundaryMessage => ({
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: {
    trigger: 'auto',
    pre_tokens: Number(payload.currentTokens ?? 0),
  },
  session_id: sessionId,
  uuid,
});

const accumulateUsage = (payload: Record<string, unknown>, state: AccumulatorState): null => {
  state.usage = {
    ...state.usage,
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

const stringifyToolResultContent = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }

  if (content == null) {
    return '';
  }

  return JSON.stringify(content) ?? String(content);
};

const toToolResult = (
  payload: Record<string, unknown>,
  sessionId: string,
  uuid: string,
  contentKey: 'output' | 'result',
): SDKToolResultMessage => ({
  type: 'tool_result',
  tool_use_id: String(payload.toolCallId ?? ''),
  content: stringifyToolResultContent(payload[contentKey]),
  is_error: Boolean(payload.isError ?? false),
  session_id: sessionId,
  uuid,
});

const toToolProgress = (payload: Record<string, unknown>, sessionId: string, uuid: string): SDKToolProgressMessage => ({
  type: 'tool_progress',
  tool_use_id: String(payload.toolCallId ?? ''),
  tool_name: normalizeToolName(String(payload.toolName ?? '')),
  parent_tool_use_id: null,
  elapsed_time_seconds: 0,
  session_id: sessionId,
  uuid,
});

const toSessionStateChanged = (
  state: 'idle' | 'running' | 'requires_action',
  sessionId: string,
  uuid: string,
): SDKSessionStateChangedMessage => ({
  type: 'system',
  subtype: 'session_state_changed',
  state,
  session_id: sessionId,
  uuid,
});

const STATELESS_MAPPERS: ReadonlyMap<string, StatelessMapper> = new Map<string, StatelessMapper>([
  ['agent.started', toSystemInit],
  [
    'agent.message_delta',
    (p, sid, id) => toAssistant([{ type: 'text', text: String(p.text ?? ''), citations: null }], sid, id),
  ],
  [
    'agent.reasoning_delta',
    (p, sid, id) => toAssistant([{ type: 'thinking', thinking: String(p.content ?? ''), signature: '' }], sid, id),
  ],
  [
    'agent.message',
    (p, sid, id) => toAssistant([{ type: 'text', text: String(p.content ?? ''), citations: null }], sid, id),
  ],
  [
    'agent.reasoning',
    (p, sid, id) => toAssistant([{ type: 'thinking', thinking: String(p.content ?? ''), signature: '' }], sid, id),
  ],
  [
    'agent.tool.use',
    (p, sid, id) => {
      const rawName = String(p.toolName ?? '');
      return toAssistant(
        [
          {
            type: 'tool_use',
            name: normalizeToolName(rawName),
            id: String(p.toolCallId ?? ''),
            input: normalizeToolInput(rawName, (p.args as Record<string, unknown>) ?? {}),
          },
        ],
        sid,
        id,
      );
    },
  ],
  ['agent.tool.output', (p, sid, id) => toToolResult(p, sid, id, 'output')],
  ['agent.tool.completed', (p, sid, id) => toToolResult(p, sid, id, 'result')],
  ['agent.tool.started', (p, sid, id) => toToolProgress(p, sid, id)],
  // Step lifecycle events carry a lightweight empty-text assistant message so
  // SDK consumers can observe block boundaries without a separate message type.
  ['agent.step.started', (_p, sid, id) => toAssistant([{ type: 'text', text: '', citations: null }], sid, id)],
  ['agent.step.finished', (_p, sid, id) => toAssistant([{ type: 'text', text: '', citations: null }], sid, id)],
  // Session state transitions
  ['agent.idle', (_p, sid, id) => toSessionStateChanged('idle', sid, id)],
  ['agent.turn.started', (_p, sid, id) => toSessionStateChanged('running', sid, id)],
]);

/**
 * Map a bus event to an SDK message, or null if the event should be accumulated.
 * @param subject - The wire subject string (e.g. 'agent.started').
 * @param payload - The bus event payload.
 * @param state - Mutable accumulator for usage counters and turn tracking.
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
  if (subject === 'agent.contextWindow.updated') return toCompactBoundary(payload, sessionId, uuid);
  if (subject === 'agent.usage') return accumulateUsage(payload, state);
  return null;
}
