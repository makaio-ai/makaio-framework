import type {
  CacheControlEphemeral,
  ContentBlockParam,
  MessageParam,
  Tool,
} from '@anthropic-ai/sdk/resources/messages/messages.js';
import {
  type MessageHandle,
  serializeTurnContext,
  formatContextBlocksAsText,
  type AIReasoningLevel,
} from '@makaio/ai-adapters-core';
import { AnthropicSdkConnectorTurn } from './turn.js';
import { AnthropicSdkConnectorSubjects, type MessageCompleteEvent } from './namespaces/index.js';
import { processStream } from './stream-bridge.js';
import { handleToolCalls, toAnthropicToolFormat } from './tool-handling.js';
import { convertMessageHistory, convertCurrentTurnBlocks } from './utils/convertMessageHistory.js';
import { parseToolUseInput } from './utils/parse-tool-use-input.js';
import type { AnthropicSdkSessionConfig } from './types/index.js';
import { classifyAnthropicError } from './utils/classifyAnthropicError.js';
import { buildMessageCreateRequest } from './utils/buildMessageCreateRequest.js';
import { BaseStreamSession } from '@makaio/ai-adapters-stream-session';
import type { ScopedSubjectDefinition } from '@makaio/core';
import type { ResponseSchemaDescriptor, ToolListItem } from '@makaio/contracts';
import { MakaioBus } from '@makaio/bus-core';

type CacheableContentBlockParam = ContentBlockParam & {
  cache_control?: CacheControlEphemeral | null;
};

/**
 * Return whether Anthropic accepts cache_control on this input block.
 * @param block - Anthropic content block to inspect
 * @returns True when cache_control can be attached
 */
function isCacheableContentBlock(block: ContentBlockParam): block is CacheableContentBlockParam {
  return block.type !== 'thinking';
}

/**
 * Session for Anthropic SDK lifecycle management.
 *
 * Manages Anthropic client calls across multiple user messages:
 * - Creates Turn instances for each user message
 * - Handles immediate mode via abort+restart (no true pause)
 * - Processes message queue with merge support
 *
 * Key difference from Claude Code: Anthropic SDK adapter has no server-side
 * session. Each turn rebuilds the messages[] array with full history.
 */
export class AnthropicSdkSession extends BaseStreamSession<
  AnthropicSdkSessionConfig,
  AnthropicSdkConnectorTurn,
  MessageCompleteEvent
> {
  protected messages: MessageParam[] = [];

  /**
   * Runtime reasoning effort level; updated by `updateReasoning()`.
   * Initialized from `config.reasoningEffort` at session construction.
   */
  protected currentReasoningEffort: AIReasoningLevel | undefined;

  /**
   * Per-turn structured output schema descriptor.
   * Captured from the active `MessageHandle.responseSchema` in `buildMessages`
   * and forwarded to `buildMessageCreateRequest` in `executeApiCall`.
   */
  private currentResponseSchema: ResponseSchemaDescriptor | undefined;

  /**
   * Mutable tool list for this session.
   * Rebuilt whenever either `nativeTools` or `mcpTools` changes.
   */
  private currentTools: Tool[];

  /** Latest native registry tools for this live session. */
  private nativeTools: Tool[];

  /**
   * Latest MCP direct-inject tools converted to Anthropic format.
   * Stored separately so that `replaceNativeTools` can rebuild `currentTools`
   * without losing the MCP tool set.
   */
  private mcpTools: Tool[] = [];

  /**
   * Create an Anthropic SDK connector session.
   * @param config - Session configuration (bus identity, model/cwd defaults, Anthropic client/tools, and lifecycle hooks).
   */
  public constructor(config: AnthropicSdkSessionConfig) {
    super(config);
    this.currentReasoningEffort = config.reasoningEffort;
    this.nativeTools = config.anthropicTools;
    this.currentTools = config.anthropicTools;
  }

  /**
   * Replace the native registry tool set used for subsequent turns.
   *
   * Rebuilds `currentTools` so that MCP tools registered via `updateTools`
   * are preserved alongside the new native tools.
   * @param tools - Fresh Anthropic-formatted native tools
   */
  public replaceNativeTools(tools: Tool[]): void {
    this.nativeTools = tools;
    this.currentTools = [...this.nativeTools, ...this.mcpTools];
  }

  /**
   * Update the session's tool set for the next API call.
   *
   * Converts generic `ToolListItem[]` (MCP direct-inject tools) to
   * Anthropic `Tool[]` format and merges them with the existing native tools.
   * @param tools - New MCP direct-inject tools in generic format
   */
  public updateTools(tools: ToolListItem[]): void {
    this.mcpTools = toAnthropicToolFormat(tools);
    this.currentTools = [...this.nativeTools, ...this.mcpTools];
  }

  /**
   * Update the reasoning effort level used for subsequent API calls.
   *
   * Called by the connector's `changeReasoningInPlace()` to sync the session
   * with the requested reasoning level without requiring a full session swap.
   * The updated value is picked up by `executeApiCall` on the next turn.
   * @internal Direct calls bypass capability validation — only the mutation
   *   manager should call this (via the connector's `changeReasoningInPlace`).
   * @param level - New reasoning effort level
   */
  public updateReasoning(level: AIReasoningLevel): void {
    this.currentReasoningEffort = level;
  }

  /**
   * Return the names of all tools that would be sent in the next API call.
   *
   * Reflects the merged set of native and MCP tools after any `replaceNativeTools`
   * or `updateTools` calls.
   * @returns Ordered list of tool names matching the next API request
   */
  protected getEffectiveToolNames(): string[] {
    return this.currentTools.map((tool) => tool.name);
  }

  // ---------------------------------------------------------------------------
  // Abstract hook implementations
  // ---------------------------------------------------------------------------

  /**
   * Create an Anthropic SDK turn for the given message handle.
   * @param handle - The message handle this turn will process
   * @returns A new `AnthropicSdkConnectorTurn` instance
   */
  protected createTurn(handle: MessageHandle): AnthropicSdkConnectorTurn {
    return new AnthropicSdkConnectorTurn(
      this.bus,
      this.config.adapterId,
      this.config.adapterName,
      this.config.agentId,
      handle,
    );
  }

  /**
   * Build the messages array from handle history and optional merged content.
   * @param handle - The message handle containing history
   * @param mergedContent - Optional content from superseded/merged messages
   */
  protected buildMessages(handle: MessageHandle, mergedContent?: string[]): void {
    // Capture the per-turn structured output schema for use in executeApiCall.
    this.currentResponseSchema = handle.responseSchema;

    // Explicit history injection replaces accumulated messages (recovery / rehydration).
    // Otherwise keep existing this.messages — they accumulate across turns (stateless API pattern).
    if (handle.messageHistory) {
      this.messages = convertMessageHistory(handle.messageHistory);
    }

    // Add merged content as user messages with acknowledgment (for immediate mode).
    if (mergedContent && mergedContent.length > 0) {
      for (const content of mergedContent) {
        this.messages.push({ role: 'user', content });
        this.messages.push({ role: 'assistant', content: 'Acknowledged.' });
      }
    }

    if (handle.cacheStrategy === 'fullPrefix' && this.messages.length > 0) {
      this.applyCacheBreakpointToLastHistoryMessage();
    }

    // Add current user message.
    // Convert blocks via the same userBlockToContentBlock path used for history so
    // that multimodal content (images, documents) is sent as native Anthropic blocks
    // rather than being serialized to text.
    const userContent = convertCurrentTurnBlocks(handle.message.blocks);
    const isEmpty = typeof userContent === 'string' ? userContent.trim().length === 0 : userContent.length === 0;
    if (isEmpty) {
      throw new Error(`[AnthropicSdkSession] Cannot send empty user content (messageId=${handle.messageId})`);
    }

    // Materialize turn context into the user message by prepending it as text.
    const contextText = formatContextBlocksAsText(serializeTurnContext(handle.turnContext));
    if (contextText.length > 0) {
      if (typeof userContent === 'string') {
        this.messages.push({ role: 'user', content: `${contextText}\n\n${userContent}` });
      } else {
        this.messages.push({ role: 'user', content: [{ type: 'text', text: contextText }, ...userContent] });
      }
    } else {
      this.messages.push({ role: 'user', content: userContent });
    }
  }

  /**
   * Return the current Anthropic messages history length.
   * @returns Number of messages currently staged for the next request
   */
  protected getConversationHistoryLength(): number {
    return this.messages.length;
  }

  /**
   * Compact provisional assistant/retry blocks to the canonical assistant turn.
   * @param startIndex - History index immediately after the user turn input
   * @param endIndex - Exclusive history boundary for the provisional blocks
   * @param assistantMessage - Canonical assistant content to persist
   */
  protected replaceAssistantTurnHistory(startIndex: number, endIndex: number, assistantMessage: string): void {
    this.messages.splice(startIndex, endIndex - startIndex, {
      role: 'assistant',
      content: assistantMessage,
    });
  }

  /**
   * Execute the Anthropic streaming API call.
   *
   * Calls `client.messages.create` with the current messages array and
   * pipes the resulting stream through the stream-bridge event emitter.
   * @param turn - Captured turn instance for this run loop
   * @param abortSignal - Combined abort signal (turn abort + stream timeout)
   * @param adapterSessionId - Turn-scoped adapter session ID for event correlation
   */
  protected async executeApiCall(
    turn: AnthropicSdkConnectorTurn,
    abortSignal: AbortSignal,
    adapterSessionId: string,
  ): Promise<void> {
    // Derive capability from the live reasoning effort set by the mutation
    // manager rather than from the config snapshot frozen at session construction.
    // After changeModelInPlace + changeReasoningInPlace, currentReasoningEffort
    // reflects whether the new model supports reasoning; config.supportedReasoningLevels
    // is stale (it was resolved for the original model).
    const supportsReasoningEffort = this.currentReasoningEffort !== undefined && this.currentReasoningEffort !== 'none';
    const requestParams = buildMessageCreateRequest({
      model: this.currentModel,
      messages: this.messages,
      tools: this.currentTools,
      reasoningEffort: this.currentReasoningEffort,
      supportsReasoningEffort,
      systemPrompt: this.config.systemPrompt,
      maxTokens: this.config.maxTokens,
      responseSchema: this.currentResponseSchema,
    });

    // Use messages.create with stream:true — returns AsyncIterable<RawMessageStreamEvent>
    const stream = await this.config.client.messages.create(requestParams, {
      signal: abortSignal,
    });

    await turn.markStepStarted();

    try {
      await processStream(stream, {
        bus: this.config.bus,
        agentId: this.config.agentId,
        adapterId: this.config.adapterId,
        adapterName: this.config.adapterName,
        adapterSessionId,
        model: this.currentModel,
        logLowLevelEvent: this.config.logLowLevelEvent,
      });
    } finally {
      await turn.markStepFinished();
    }
  }

  /**
   * Return the Anthropic SDK event bus subject for `message_complete` waiting.
   * @returns The `sdk.event` subject for the Anthropic adapter namespace
   */
  protected getSdkEventSubject(): ScopedSubjectDefinition<string> {
    return AnthropicSdkConnectorSubjects.sdk.event;
  }

  /**
   * Apply a `message_complete` event to the Anthropic messages array and
   * recurse for tool calls.
   *
   * Appends assistant content as Anthropic `MessageParam[]` blocks. When
   * `finish_reason` is `'tool_use'`, executes tools and continues the loop.
   * @param result - The parsed Anthropic `message_complete` event
   * @param currentHandle - The active message handle
   * @param toolCallIteration - Current tool recursion depth
   * @param turn - Captured turn instance for this run loop
   */
  protected async applyMessageComplete(
    result: MessageCompleteEvent,
    currentHandle: MessageHandle,
    toolCallIteration: number,
    turn: AnthropicSdkConnectorTurn,
  ): Promise<void> {
    if (this.shouldAbortTurnProcessing(turn, currentHandle)) {
      return;
    }

    const messageContent = result.content || null;

    // Append assistant message to history.
    // Anthropic format: assistant messages use content block arrays.
    if (result.tool_calls && result.tool_calls.length > 0) {
      // Build assistant content with text + tool_use blocks.
      const assistantContent: MessageParam['content'] = [];
      if (messageContent) {
        assistantContent.push({ type: 'text', text: messageContent });
      }
      for (const tc of result.tool_calls) {
        // Keep assistant history valid for Anthropic by enforcing object input.
        const parsedArgs = parseToolUseInput(tc.function.arguments);
        assistantContent.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input: parsedArgs,
        });
      }
      this.messages.push({ role: 'assistant', content: assistantContent });
    } else {
      this.messages.push({ role: 'assistant', content: messageContent ?? '' });
    }

    this.lastAssistantMessage = messageContent || '';

    if (result.finish_reason === 'tool_use' && result.tool_calls && result.tool_calls.length > 0) {
      if (toolCallIteration >= BaseStreamSession.MAX_TOOL_CALL_ITERATIONS) {
        throw new Error(
          `Tool call iteration limit exceeded (${BaseStreamSession.MAX_TOOL_CALL_ITERATIONS}). Aborting to prevent context blowup.`,
        );
      }

      const toolResultBlocks = await handleToolCalls(
        result.tool_calls,
        {
          bus: this.config.globalBus ?? MakaioBus,
          emitSdkEvent: this.config.emitSdkEvent,
          requestToolApproval: this.config.requestToolApproval,
          recordMcpCall: this.config.recordMcpCall,
        },
        {
          env: this.config.env,
          cwd: this.currentCwd,
          // Use stable Makaio session identity for tool attribution.
          // `this.sessionId` is the adapter-local turn/session UUID and rotates per turn.
          sessionId: this.config.sessionId,
          agentId: this.config.agentId,
          adapterId: this.config.adapterId,
          adapterName: this.config.adapterName,
          adapterSessionId: this.config.adapterSessionId,
          turnId: currentHandle.messageId,
          turnContext: currentHandle.turnContext,
          reasoning: result.reasoning,
          constraints: this.buildToolConstraints(),
        },
      );

      // Tool results go back as a user message.
      this.messages.push({ role: 'user', content: toolResultBlocks });

      await this.runTurnIteration(turn, currentHandle, toolCallIteration + 1);
    }
  }

  /**
   * Mark the last content block of the last history message with an ephemeral
   * cache_control breakpoint. This tells Anthropic to cache everything up to
   * and including this block, guaranteeing the injected history prefix hits cache.
   */
  private applyCacheBreakpointToLastHistoryMessage(): void {
    this.clearCacheBreakpoints();

    for (let messageIndex = this.messages.length - 1; messageIndex >= 0; messageIndex--) {
      const message = this.messages[messageIndex];
      if (typeof message.content === 'string') {
        // Convert string content to a TextBlockParam array so we can attach cache_control.
        message.content = [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }];
        return;
      }

      for (let blockIndex = message.content.length - 1; blockIndex >= 0; blockIndex--) {
        const block = message.content[blockIndex];
        if (isCacheableContentBlock(block)) {
          block.cache_control = { type: 'ephemeral' };
          return;
        }
      }
    }
  }

  /**
   * Remove stale prompt-cache breakpoints before placing the current prefix boundary.
   */
  private clearCacheBreakpoints(): void {
    for (const message of this.messages) {
      if (typeof message.content === 'string') continue;
      for (const block of message.content) {
        if (isCacheableContentBlock(block)) {
          delete block.cache_control;
        }
      }
    }
  }

  /**
   * Classify an Anthropic SDK error into the appropriate Makaio error type.
   * @param error - The raw error from the Anthropic SDK
   * @returns A classified `Error` instance
   */
  protected classifyError(error: unknown): Error {
    return classifyAnthropicError(error);
  }
}
