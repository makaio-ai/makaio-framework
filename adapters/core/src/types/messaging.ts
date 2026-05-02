/**
 * Re-export canonical bus message types from contracts.
 * These are the canonical types for adapter/agent communication.
 *
 * Note: We re-export from contracts rather than re-inferring via z.infer
 * to ensure type identity with bus handler expectations.
 */

/** Request payload for adapter.startAgent bus subject. */
export type { StartAgentRequest } from '@makaio/contracts';
/** Response payload for adapter.startAgent bus subject. */
export type { StartAgentResponse } from '@makaio/contracts';
/** Request payload for agent.sendMessage bus subject. */
export type { SendMessageRequest } from '@makaio/contracts';
/** Response payload for agent.sendMessage bus subject. */
export type { SendMessageResponse } from '@makaio/contracts';

/**
 * Options for `AIAdapter.promptText()`.
 *
 * Minimal universal parameters with provider-specific escape hatch.
 * @example
 * ```typescript
 * await adapter.promptText("Build an auth system", {
 *   model: "gpt-4o",
 *   sessionId: "user-123-conv-456",
 *   providerOptions: { temperature: 0.7 }
 * });
 * ```
 * @see {@link AIAdapterPromptResult} for response type
 * @see `AIAdapter.promptText` for usage
 * @see [Message Handling Guide](../../docs/message-handling.md)
 */
export interface AIAdapterPromptOptions {
  /** Model identifier (provider-specific). Defaults to adapter's configured model if omitted. */
  model?: string;

  /** Session ID for conversation continuity. Creates new session if omitted. Check `caps.sessionResume` for persistence support. */
  sessionId?: string;

  /** Provider-specific options (temperature, tools, system prompts, etc.). Type explicitly in adapter implementations. */
  providerOptions?: unknown;
}

/**
 * Successful prompt result with text response.
 * @see {@link AIAdapterPromptResult} for discriminated union
 */
export interface AIAdapterPromptSuccessResult {
  /** Complete text response from AI model. For streaming events, contains final assembled text. */
  text: string;
}

/**
 * Failed prompt result. Adapters return errors as values rather than throwing.
 * @see {@link AIAdapterPromptResult} for discriminated union
 */
export interface AIAdapterPromptFailureResult {
  /** Error message (string) or Error object describing failure. */
  error: string | Error;
}

/**
 * Result from `AIAdapter.promptText()`. Discriminated union of success/failure.
 * @example
 * ```typescript
 * const result = await adapter.promptText("Build auth");
 *
 * if ('error' in result) {
 *   console.error('Failed:', result.error);
 * } else {
 *   console.debug('Success:', result.text);
 * }
 * ```
 * @see {@link AIAdapterPromptSuccessResult} for success structure
 * @see {@link AIAdapterPromptFailureResult} for failure structure
 * @see `AIAdapter.promptText` for usage
 * @see [Message Handling Guide](../../docs/message-handling.md)
 */
export type AIAdapterPromptResult = AIAdapterPromptFailureResult | AIAdapterPromptSuccessResult;
