import os from 'node:os';
import { vi } from 'vitest';
import { MessageHandle } from '@makaio/ai-adapters-core';
import type { SDKMessage } from '@makaio/client-claude-code';

/**
 * Standard usage payload shared across default query mock responses.
 * All token counts are minimal stubs — tests care about structure, not values.
 */
export const SDK_USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  },
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  server_tool_use: { web_search_requests: 0 },
  service_tier: 'standard',
};

/**
 * Build the shared identity fields present on every SDK message.
 * @param sessionId - The effective session ID for this query invocation
 * @returns Object with uuid, session_id, and agentId fields
 */
export function makeSdkBase(sessionId: string): {
  uuid: string;
  session_id: string;
  agentId: string;
} {
  return {
    uuid: crypto.randomUUID(),
    session_id: sessionId,
    agentId: 'agent-test',
  };
}

/**
 * Build a `system.init` SDK message for the given session.
 * @param sessionId - The effective session ID for this query invocation
 * @returns A `system` subtype `init` SDK message
 */
export function makeInitMessage(sessionId: string): SDKMessage {
  return {
    ...makeSdkBase(sessionId),
    type: 'system',
    subtype: 'init',
    apiKeySource: 'user',
    cwd: os.tmpdir(),
    tools: [],
    mcp_servers: [],
    model: 'claude-sonnet-4-20250514',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
  } as SDKMessage;
}

/**
 * Options for building a result message.
 */
export interface ResultMessageOptions {
  /** Result text. Defaults to `'session completed'`. */
  result?: string;
  /** When set, the result carries `structured_output` and clears the text result. */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
}

/**
 * Build a `result.success` SDK message for the given session.
 * @param sessionId - The effective session ID for this query invocation
 * @param options - Optional overrides for result text and structured output
 * @returns A `result` subtype `success` SDK message
 */
export function makeResultMessage(sessionId: string, options?: ResultMessageOptions): SDKMessage {
  const { result = 'session completed', outputFormat } = options ?? {};
  return {
    ...makeSdkBase(sessionId),
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: outputFormat !== undefined ? '' : result,
    ...(outputFormat !== undefined && { structured_output: { ok: true } }),
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: SDK_USAGE,
    modelUsage: {},
    permission_denials: [],
  } as SDKMessage;
}

/**
 * Options controlling the default query mock implementation.
 */
export interface DefaultQueryImplOptions {
  /**
   * When true, the iterator yields a `rate_limit_event` before `system.init`.
   * Required by tests that verify rate-limit handling.
   * Default: false.
   */
  includeRateLimitEvent?: boolean;
  /**
   * When true, the query signature accepts an `outputFormat` option and the
   * result message conditionally yields `structured_output`.
   * Default: false.
   */
  includeOutputFormat?: boolean;
}

/**
 * Install the standard query mock implementation on the given vi.fn() stub.
 * Should be called from `beforeEach` so each test starts with a fresh default.
 *
 * The default iterator yields: (optionally) `rate_limit_event` → `system.init`
 * → `result.success`, mirroring the pattern all three SDK session test files
 * previously duplicated inside their `vi.hoisted` blocks.
 * @param query - The vi.fn() mock to receive the implementation
 * @param options - Flags controlling which messages the default iterator yields
 */
export function installDefaultQueryImpl(
  query: ReturnType<typeof vi.fn>,
  options: DefaultQueryImplOptions = {},
): void {
  const { includeRateLimitEvent = false, includeOutputFormat = false } = options;

  query.mockImplementation(
    ({
      prompt,
      options: queryOptions,
    }: {
      prompt: AsyncIterable<unknown>;
      options: {
        sessionId?: string;
        resume?: string;
        outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> };
      };
    }) => {
      const effectiveSessionId = queryOptions.resume ?? queryOptions.sessionId ?? crypto.randomUUID();
      return {
        interrupt: vi.fn(async () => undefined),
        close: vi.fn(() => undefined),
        setMcpServers: vi.fn(async () => ({ added: [], removed: [], errors: {} })),
        setMaxThinkingTokens: vi.fn(async () => undefined),
        async *[Symbol.asyncIterator]() {
          for await (const _message of prompt) {
            if (includeRateLimitEvent) {
              yield {
                type: 'rate_limit_event',
                retry_after_ms: 1000,
                session_id: effectiveSessionId,
              };
            }
            yield makeInitMessage(effectiveSessionId);
            yield makeResultMessage(
              effectiveSessionId,
              includeOutputFormat ? { outputFormat: queryOptions.outputFormat } : undefined,
            );
          }
        },
      };
    },
  );
}

/**
 * Create a minimal message handle for SDK session turn tests.
 * @param messageId - Handle identifier, defaults to `'message-1'`
 * @param deliveryMode - Delivery mode, defaults to `'enqueue'`
 * @param responseSchema - Optional structured-output schema for the handle
 * @returns A new MessageHandle with a text 'hello' user message
 */
export function createMessageHandle(
  messageId = 'message-1',
  deliveryMode: 'enqueue' | 'replace' | 'immediate' = 'enqueue',
  responseSchema?: MessageHandle['responseSchema'],
): MessageHandle {
  return new MessageHandle(
    messageId,
    {
      role: 'user',
      blocks: [{ type: 'text', content: 'hello' }],
      message: 'hello',
    },
    deliveryMode,
    undefined,
    undefined,
    responseSchema,
  );
}
