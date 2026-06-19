import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/index.js';
import {
  type MessageHandle,
  serializeTurnContext,
  formatContextBlocksAsText,
  type AIReasoningLevel,
} from '@makaio/ai-adapters-core';
import { blocksToContentParts } from './utils/blockToContentPart.js';
import { OpenAIConnectorTurn } from './turn.js';
import { OpenAINodeConnectorSubjects, type MessageCompleteEvent } from './namespaces/index.js';
import { processStream } from './stream-bridge.js';
import { handleToolCalls, toOpenAIToolFormat } from './tool-handling.js';
import { convertMessageHistory } from './utils/convertMessageHistory.js';
import type { OpenAISessionConfig } from './types/index.js';
import { classifyOpenAIError } from './utils/classifyOpenAIError.js';
import { buildChatCompletionRequest } from './utils/buildChatCompletionRequest.js';
import { getOpenAIToolName } from './utils/getOpenAIToolName.js';
import { BaseStreamSession, type MessageToolCall } from '@makaio/ai-adapters-stream-session';
import type { ScopedSubjectDefinition } from '@makaio/core';
import type { CacheStrategy, ResponseSchemaDescriptor, ToolListItem } from '@makaio/contracts';
import { STRUCTURED_OUTPUT_FINALIZER_TOOL_NAME } from './structured-output-finalizer.js';

/**
 * Session for OpenAI SDK lifecycle management.
 *
 * Manages OpenAI client calls across multiple user messages:
 * - Creates Turn instances for each user message
 * - Handles immediate mode via abort+restart (no true pause)
 * - Processes message queue with merge support
 *
 * Key difference from Claude: OpenAI has no server-side session.
 * Each turn rebuilds the messages[] array with full history.
 */
export class OpenAIConnectorSession extends BaseStreamSession<
  OpenAISessionConfig,
  OpenAIConnectorTurn,
  MessageCompleteEvent
> {
  protected messages: ChatCompletionMessageParam[] = [];

  /**
   * Mutable tool list for this session.
   * Rebuilt whenever either `nativeTools` or `mcpTools` changes.
   */
  private currentTools: ChatCompletionTool[];

  /** Latest native registry tools for this live session. */
  private nativeTools: ChatCompletionTool[];

  /**
   * Latest MCP direct-inject tools converted to OpenAI format.
   * Stored separately so that `replaceNativeTools` can rebuild `currentTools`
   * without losing the MCP tool set.
   */
  private mcpTools: ChatCompletionTool[] = [];

  /**
   * Runtime reasoning effort level; updated by `updateReasoning()`.
   * Initialized from `config.reasoningEffort` at session construction.
   */
  private currentReasoningEffort: AIReasoningLevel | undefined;

  /**
   * Per-turn structured-output schema descriptor, captured from the active
   * {@link MessageHandle} in {@link buildMessages} and consumed by
   * {@link executeApiCall} when building the `response_format` payload.
   * Reset to `undefined` at the start of each new turn.
   */
  private currentResponseSchema: ResponseSchemaDescriptor | undefined;

  /** Per-turn cache strategy, captured from the active MessageHandle in buildMessages. */
  private currentCacheStrategy: CacheStrategy | undefined;

  /**
   * Create an OpenAI connector session.
   * @param config - OpenAI session configuration (bus identity, model/cwd, SDK client, and lifecycle hooks).
   */
  public constructor(config: OpenAISessionConfig) {
    super(config);
    this.nativeTools = config.openAITools;
    this.currentTools = config.openAITools;
    this.currentReasoningEffort = config.reasoningEffort;
  }

  /**
   * Replace the native registry tool set used for subsequent turns.
   *
   * Rebuilds `currentTools` so that MCP tools registered via `updateTools`
   * are preserved alongside the new native tools.
   * @param tools - Fresh OpenAI-formatted native tools
   */
  public replaceNativeTools(tools: ChatCompletionTool[]): void {
    this.nativeTools = tools;
    this.currentTools = [...this.nativeTools, ...this.mcpTools];
  }

  /**
   * Update the session's tool set for the next API call.
   *
   * Converts generic `ToolListItem[]` (MCP direct-inject tools) to
   * OpenAI `ChatCompletionTool[]` format and merges them with the existing native tools.
   * @param tools - New MCP direct-inject tools in generic format
   */
  public updateTools(tools: ToolListItem[]): void {
    this.mcpTools = toOpenAIToolFormat(tools);
    this.currentTools = [...this.nativeTools, ...this.mcpTools];
  }

  /**
   * Update the reasoning effort level used for subsequent API calls.
   *
   * Called by the connector's `changeReasoningInPlace()` to sync the session
   * with the connector-level reasoning effort without requiring a full session
   * swap. The updated value is picked up by `executeApiCall` on the next turn.
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
    return this.currentTools.map(getOpenAIToolName);
  }

  /**
   * Return true when OpenAI-compatible tool calling must carry the structured
   * result because the active provider rejects `response_format` alongside tools.
   *
   * Providers that natively support `response_format: json_schema` with tools
   * (e.g., OpenAI) bypass this workaround entirely.
   * @returns Whether this turn should use the internal finalizer tool
   */
  private shouldUseStructuredOutputFinalizer(): boolean {
    if (this.config.supportsResponseFormatWithTools) {
      return false;
    }
    return this.currentResponseSchema !== undefined && this.currentTools.length > 0;
  }

  /**
   * Build the internal terminal tool used when structured output and normal
   * tool calling are both active.
   * @returns OpenAI function tool that submits the final structured result
   */
  private createStructuredOutputFinalizerTool(): ChatCompletionTool {
    if (this.currentResponseSchema === undefined) {
      throw new Error('Structured output finalizer requires an active response schema');
    }

    return {
      type: 'function',
      function: {
        name: STRUCTURED_OUTPUT_FINALIZER_TOOL_NAME,
        description: 'Submit the final structured response for this turn after any required tools have been used.',
        parameters: this.currentResponseSchema.schema,
        ...(this.currentResponseSchema.strict === true && { strict: true }),
      },
    };
  }

  /**
   * Build the tool list for the next OpenAI request.
   * @returns Normal tools plus the internal finalizer when needed
   */
  protected buildRequestTools(): ChatCompletionTool[] {
    if (!this.shouldUseStructuredOutputFinalizer()) {
      return this.currentTools;
    }
    if (this.currentTools.some((tool) => getOpenAIToolName(tool) === STRUCTURED_OUTPUT_FINALIZER_TOOL_NAME)) {
      throw new Error(`Tool name ${STRUCTURED_OUTPUT_FINALIZER_TOOL_NAME} is reserved for structured output.`);
    }
    return [...this.currentTools, this.createStructuredOutputFinalizerTool()];
  }

  /**
   * Return the response schema to send via OpenAI `response_format`.
   *
   * The schema is intentionally omitted when the finalizer tool is active
   * because some OpenAI-compatible providers reject `response_format` and
   * function tools in the same request.
   * @returns Direct response schema for schema-only turns, otherwise undefined
   */
  protected getRequestResponseSchema(): ResponseSchemaDescriptor | undefined {
    if (this.shouldUseStructuredOutputFinalizer()) {
      return undefined;
    }
    return this.currentResponseSchema;
  }

  /**
   * Instruction prepended to the current user turn when the internal finalizer
   * tool is required.
   * @returns Internal turn instruction or an empty string
   */
  private getStructuredOutputFinalizerInstruction(): string {
    if (!this.shouldUseStructuredOutputFinalizer()) {
      return '';
    }
    return [
      'Structured output is required for this turn.',
      `When you are ready to provide the final answer, call the ${STRUCTURED_OUTPUT_FINALIZER_TOOL_NAME} function exactly once with arguments matching its schema.`,
      'Use other tools first when needed. Do not provide the final answer as plain text.',
    ].join(' ');
  }

  // ---------------------------------------------------------------------------
  // Abstract hook implementations
  // ---------------------------------------------------------------------------

  /**
   * Create an OpenAI connector turn for the given message handle.
   * @param handle - The message handle this turn will process
   * @returns A new `OpenAIConnectorTurn` instance
   */
  protected createTurn(handle: MessageHandle): OpenAIConnectorTurn {
    return new OpenAIConnectorTurn(
      this.bus,
      this.config.adapterId,
      this.config.adapterName,
      this.config.agentId,
      handle,
    );
  }

  /**
   * Validate that content is non-empty after trim.
   * Throws an Error with a descriptive message if content is empty.
   * @param content - Content string to validate
   * @param messageId - Message ID for error context
   * @param context - Additional context for the error message
   */
  private throwIfEmptyContent(content: string, messageId: string, context: string): void {
    if (content.trim().length === 0) {
      throw new Error(`[${context}] buildMessages produced empty user content (messageId=${messageId})`);
    }
  }

  /**
   * Build the messages array from handle history and optional merged content.
   *
   * Ensures the configured system prompt is always at index 0 without
   * duplicating existing history system entries.
   *
   * Also snapshots {@link MessageHandle.responseSchema} into
   * {@link currentResponseSchema} so {@link executeApiCall} can forward it to
   * the OpenAI `response_format` field without re-reading the handle.
   * @param handle - The message handle containing history
   * @param mergedContent - Optional content from superseded/merged messages
   */
  protected buildMessages(handle: MessageHandle, mergedContent?: string[]): void {
    // Snapshot per-turn schemas for use in executeApiCall.
    this.currentResponseSchema = handle.responseSchema;
    this.currentCacheStrategy = handle.cacheStrategy;

    // Explicit history injection replaces accumulated messages (recovery / rehydration).
    // Otherwise keep existing this.messages — they accumulate across turns (stateless API pattern).
    if (handle.messageHistory) {
      this.messages = convertMessageHistory(handle.messageHistory);
    }

    // Ensure configured system prompt is always at index 0 without duplicating
    // history system entries.
    if (this.config.systemPrompt !== undefined) {
      const firstSystemIndex = this.messages.findIndex((message) => message.role === 'system');
      if (firstSystemIndex >= 0) {
        const [systemMessage] = this.messages.splice(firstSystemIndex, 1);
        this.messages.unshift({
          ...systemMessage,
          content: this.config.systemPrompt,
        });
      } else {
        this.messages.unshift({
          role: 'system',
          content: this.config.systemPrompt,
        });
      }
    }

    // Add merged content as user messages with acknowledgment (for immediate mode).
    if (mergedContent && mergedContent.length > 0) {
      for (const content of mergedContent) {
        this.messages.push({ role: 'user', content });
        this.messages.push({ role: 'assistant', content: 'Acknowledged.' });
      }
    }

    // Add current user message.
    // NormalizedMessageInput.message is optional (undefined for block-only inputs);
    // build structured content parts so media blocks (images, PDFs, attachments)
    // are passed natively to the OpenAI API rather than as text placeholders.
    const contextText = [
      formatContextBlocksAsText(serializeTurnContext(handle.turnContext)),
      this.getStructuredOutputFinalizerInstruction(),
    ]
      .filter((text) => text.length > 0)
      .join('\n\n');

    if (handle.message.message !== undefined) {
      // Simple string message — prepend context text when present.
      const content = contextText.length > 0 ? `${contextText}\n\n${handle.message.message}` : handle.message.message;
      this.throwIfEmptyContent(content, handle.messageId, 'OpenAIConnectorSession');
      this.messages.push({ role: 'user', content });
    } else {
      // Block-based message — convert to OpenAI content parts.
      const parts = blocksToContentParts(handle.message.blocks);
      if (contextText.length > 0) {
        parts.unshift({ type: 'text', text: contextText });
      }
      // Attachments/media may produce non-text parts as the first element.
      // Only reject when there is no non-empty text and no non-text part at all.
      const textContent = parts
        .filter((part): part is Extract<(typeof parts)[number], { type: 'text' }> => part.type === 'text')
        .map((part) => part.text ?? '')
        .join('');
      const hasNonTextPart = parts.some((part) => part.type !== 'text');
      if (!hasNonTextPart) {
        this.throwIfEmptyContent(textContent, handle.messageId, 'OpenAIConnectorSession');
      }
      this.messages.push({ role: 'user', content: parts });
    }
  }

  /**
   * Return the current OpenAI chat history length.
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
   * Execute the OpenAI streaming API call.
   *
   * Calls `client.chat.completions.create` with the current messages array
   * and pipes the resulting stream through the stream-bridge event emitter.
   * @param turn - Captured turn instance for this run loop
   * @param abortSignal - Combined abort signal (turn abort + stream timeout)
   * @param adapterSessionId - Turn-scoped adapter session ID for event correlation
   */
  protected async executeApiCall(
    turn: OpenAIConnectorTurn,
    abortSignal: AbortSignal,
    adapterSessionId: string,
  ): Promise<void> {
    // Derive capability from the live reasoning effort set by the mutation
    // manager rather than from the config snapshot frozen at session construction.
    // After changeModelInPlace + changeReasoningInPlace, currentReasoningEffort
    // reflects whether the new model supports reasoning; config.supportedReasoningLevels
    // is stale (it was resolved for the original model).
    //
    // supportsReasoningEffort is derived from currentReasoningEffort (live state)
    // rather than from a capability map. This is safe because the mutation manager
    // is the sole caller of changeModelInPlace/changeReasoningInPlace and always
    // reconciles reasoning effort against the model's supported levels before
    // updating the session. A stale capability map would require a second update
    // seam without additional safety benefit.
    //
    // Per-level validation is handled upstream by AgentRuntimeMutationManager
    // before changeReasoningInPlace is called. The session layer only checks
    // feature presence, not individual level support.
    const supportsReasoningEffort = this.currentReasoningEffort !== undefined && this.currentReasoningEffort !== 'none';
    const stream = await this.config.client.chat.completions.create(
      buildChatCompletionRequest({
        model: this.currentModel,
        messages: this.messages,
        tools: this.buildRequestTools(),
        reasoningEffort: this.currentReasoningEffort,
        supportsReasoningEffort,
        responseSchema: this.getRequestResponseSchema(),
        supportsStructuredOutputStrict: this.config.supportsStructuredOutputStrict,
        cacheStrategy: this.currentCacheStrategy,
        systemPrompt: this.config.systemPrompt,
      }),
      { signal: abortSignal },
    );

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
        hiddenToolCallNames: this.shouldUseStructuredOutputFinalizer()
          ? [STRUCTURED_OUTPUT_FINALIZER_TOOL_NAME]
          : undefined,
      });
    } finally {
      await turn.markStepFinished();
    }
  }

  /**
   * Return the OpenAI Node event bus subject for `message_complete` waiting.
   * @returns The `sdk.event` subject for the OpenAI adapter namespace
   */
  protected getSdkEventSubject(): ScopedSubjectDefinition<string> {
    return OpenAINodeConnectorSubjects.sdk.event;
  }

  /**
   * Apply a `message_complete` event to the OpenAI messages array and recurse
   * for tool calls.
   *
   * Appends the assistant response as a `ChatCompletionMessageParam`. When
   * `finish_reason` is `'tool_calls'`, executes tools and continues the loop.
   * @param result - The parsed OpenAI `message_complete` event
   * @param currentHandle - The active message handle
   * @param toolCallIteration - Current tool recursion depth
   * @param turn - Captured turn instance for this run loop
   */
  protected async applyMessageComplete(
    result: MessageCompleteEvent,
    currentHandle: MessageHandle,
    toolCallIteration: number,
    turn: OpenAIConnectorTurn,
  ): Promise<void> {
    if (this.shouldAbortTurnProcessing(turn, currentHandle)) {
      return;
    }

    const structuredOutputMessage = this.extractStructuredOutputFinalizerMessage(result.tool_calls);
    if (structuredOutputMessage !== undefined) {
      this.messages.push({
        role: 'assistant',
        content: structuredOutputMessage,
      });
      this.lastAssistantMessage = structuredOutputMessage;
      return;
    }

    const messageContent = result.content || null;
    const assistantMessage: ChatCompletionMessageParam = {
      role: 'assistant',
      content: messageContent,
    };

    if (result.tool_calls && result.tool_calls.length > 0) {
      assistantMessage.tool_calls = result.tool_calls;
    }

    this.messages.push(assistantMessage);
    this.lastAssistantMessage = messageContent || '';

    if (result.finish_reason === 'tool_calls' && result.tool_calls && result.tool_calls.length > 0) {
      if (toolCallIteration >= BaseStreamSession.MAX_TOOL_CALL_ITERATIONS) {
        throw new Error(
          `Tool call iteration limit exceeded (${BaseStreamSession.MAX_TOOL_CALL_ITERATIONS}). Aborting to prevent context blowup.`,
        );
      }
      const messagesFromToolCalls = await handleToolCalls(
        result.tool_calls,
        {
          emitSdkEvent: this.config.emitSdkEvent,
          requestToolApproval: this.config.requestToolApproval,
          recordMcpCall: this.config.recordMcpCall,
        },
        {
          env: this.config.env,
          cwd: this.currentCwd,
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

      this.messages.push(...messagesFromToolCalls);
      await this.runTurnIteration(turn, currentHandle, toolCallIteration + 1);
    }
  }

  /**
   * Classify an OpenAI SDK error into the appropriate Makaio error type.
   * @param error - The raw error from the OpenAI SDK
   * @returns A classified `Error` instance
   */
  protected classifyError(error: unknown): Error {
    return classifyOpenAIError(error);
  }

  /**
   * Convert an internal structured-output finalizer call into terminal content.
   * @param toolCalls - Tool calls from the current message_complete event
   * @returns Serialized final structured output, or undefined when absent
   */
  private extractStructuredOutputFinalizerMessage(toolCalls: MessageToolCall[] | undefined): string | undefined {
    if (!this.shouldUseStructuredOutputFinalizer() || toolCalls === undefined) {
      return undefined;
    }

    const finalizerCalls = toolCalls.filter(
      (toolCall) => toolCall.function.name === STRUCTURED_OUTPUT_FINALIZER_TOOL_NAME,
    );
    if (finalizerCalls.length === 0) {
      return undefined;
    }
    if (finalizerCalls.length > 1 || finalizerCalls.length !== toolCalls.length) {
      throw new Error('Structured output finalizer must be the only tool call in the terminal OpenAI response.');
    }

    const [finalizerCall] = finalizerCalls;
    try {
      return JSON.stringify(JSON.parse(finalizerCall.function.arguments) as unknown);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Structured output finalizer emitted invalid JSON arguments: ${message}`);
    }
  }
}
