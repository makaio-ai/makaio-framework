import { BaseStreamAgent, type StreamAdapterSubjectSpec } from '@makaio/ai-adapters-stream-session';
import type { NormalizedCallUsage } from '@makaio/ai-adapters-core';
import { AnthropicSdkConnector } from './connector.js';
import {
  AnthropicSdkConnectorSubjects,
  type AnthropicSdkConnectorBus,
  type ToolCall,
  UsageEvent,
} from './namespaces/index.js';
import { registerToolApprovalHandler } from './tool-handling.js';
import type { SessionMessageBlock } from '@makaio/contracts';

const DEFAULT_CONTEXT_WINDOW_SIZE = 200_000;

/**
 * Subject spec for the Anthropic SDK adapter, satisfying `StreamAdapterSubjectSpec`.
 *
 * Scoped to the Anthropic SDK connector namespace. Passed as the `TSpec` type parameter
 * to `BaseStreamAgent` so shared wire methods resolve handler types correctly.
 */
type AnthropicSubjectSpec = StreamAdapterSubjectSpec<typeof AnthropicSdkConnectorSubjects.chunk.$meta.namespace>;

/**
 * Anthropic SDK Agent — Middle layer between AnthropicSdkAdapter and AnthropicSdkConnector.
 *
 * Responsibilities:
 * 1. Wire connector's scoped bus events to global agent.* subjects
 * 2. Auto-enrich payloads with AgentContext via emitGlobal()
 *
 * Event Flow:
 * - AnthropicSdkConnector emits to semantic subjects (chunk, usage, etc.)
 * - AnthropicSdkAgent subscribes to semantic subjects and emits to global bus (agent.*)
 * - Downstream consumers subscribe to normalized agent.* subjects
 *
 * Extends `BaseStreamAgent` which provides all shared wiring logic. This class only
 * implements the adapter-specific abstract hooks.
 */
export class AnthropicSdkAgent extends BaseStreamAgent<
  AnthropicSdkConnectorBus,
  AnthropicSdkConnector,
  AnthropicSubjectSpec
> {
  /**
   * Keep AIAgent's internal block index counter in sync with provider block indices.
   *
   * Some steps (tool_use) emit provider-native indices directly instead of going through
   * emitStepStarted/emitStepFinished, so we advance the local counter to avoid reusing
   * stale indices for later text/reasoning steps in the same turn.
   * @param blockIndex - Provider block index that has been reserved/emitted
   */
  private reconcileInternalBlockIndex(blockIndex: number): void {
    while (this.getBlockIndex() <= blockIndex) {
      this.incrementBlockIndex();
    }
  }

  // ---------------------------------------------------------------------------
  // Abstract hook implementations — Anthropic-specific
  // ---------------------------------------------------------------------------

  /**
   * Tier 1: Route sdk.event catch-all to typed semantic subjects.
   *
   * Uses `createConnectorEventMapping` for type-safe discriminated union routing.
   * The envelope `'event'` field carries the discriminated union keyed on `'eventType'`.
   */
  protected wireSdkEvents(): void {
    this.createConnectorEventMapping(
      AnthropicSdkConnectorSubjects.sdk.event,
      'eventType',
      {
        chunk: AnthropicSdkConnectorSubjects.chunk,
        usage: AnthropicSdkConnectorSubjects.usage,
        tool_calls: AnthropicSdkConnectorSubjects.tool_calls,
        message_complete: AnthropicSdkConnectorSubjects.message_complete,
        reasoning_delta: AnthropicSdkConnectorSubjects.reasoning_delta,
        reasoning_complete: AnthropicSdkConnectorSubjects.reasoning_complete,
        agent_started: AnthropicSdkConnectorSubjects.agent_started,
        agent_complete: AnthropicSdkConnectorSubjects.agent_complete,
        error: AnthropicSdkConnectorSubjects.error,
        tool_started: AnthropicSdkConnectorSubjects.tool_started,
        tool_completed: AnthropicSdkConnectorSubjects.tool_completed,
      },
      'event',
    );
  }

  /**
   * Return the Anthropic SDK adapter's connector subject spec.
   *
   * Maps adapter subject constants to the `StreamAdapterSubjectSpec` interface used
   * by `BaseStreamAgent` to subscribe to semantic events.
   * @returns Anthropic-specific subject spec
   */
  protected getConnectorSubjects(): AnthropicSubjectSpec {
    // Cast: each returned subject is an event subject (not a request), satisfying EventSubjectDef.
    // The full namespace record carries tool_approval (a request), which prevents structural
    // assignability at the SubjectDefinition meta level. The cast is safe because the
    // concrete subjects' payloads are all EventMessagePayload at their specific subject keys.
    return {
      chunk: AnthropicSdkConnectorSubjects.chunk,
      usage: AnthropicSdkConnectorSubjects.usage,
      toolCalls: AnthropicSdkConnectorSubjects.tool_calls,
      reasoningComplete: AnthropicSdkConnectorSubjects.reasoning_complete,
      messageComplete: AnthropicSdkConnectorSubjects.message_complete,
      reasoningDelta: AnthropicSdkConnectorSubjects.reasoning_delta,
      toolStarted: AnthropicSdkConnectorSubjects.tool_started,
      toolCompleted: AnthropicSdkConnectorSubjects.tool_completed,
      agentStarted: AnthropicSdkConnectorSubjects.agent_started,
      agentComplete: AnthropicSdkConnectorSubjects.agent_complete,
      error: AnthropicSdkConnectorSubjects.error,
    } as AnthropicSubjectSpec;
  }

  /**
   * Extract plain text from an Anthropic chunk event payload.
   *
   * Anthropic chunk events carry a discriminated `delta` union. Text content is
   * only present when `delta.type === 'text_delta'`.
   * @param payload - Anthropic chunk event payload
   * @returns The text content, or empty string for non-text deltas
   */
  protected extractChunkText(payload: Record<string, unknown>): string {
    const { delta } = payload as { delta: { type: string; text?: string } };
    if (delta.type === 'text_delta') {
      return delta.text ?? '';
    }
    return '';
  }

  /**
   * Map an Anthropic usage event payload to the shared `NormalizedCallUsage` format.
   *
   * Reads Anthropic-specific cache fields: `cache_read_input_tokens` and
   * `cache_creation_input_tokens`.
   *
   * Granularity is `provider-call`: each usage event is merged from the
   * `message_start`/`message_delta` frames of exactly one Anthropic request.
   * @param payload - Anthropic usage event payload
   * @returns Normalized usage metrics
   */
  protected extractUsagePayload(payload: Record<string, unknown>): NormalizedCallUsage {
    const usage = payload as UsageEvent;
    return {
      ...(usage.llmCallId !== undefined ? { llmCallId: usage.llmCallId } : {}),
      ...(usage.executionId !== undefined ? { executionId: usage.executionId } : {}),
      ...(usage.frameId !== undefined ? { frameId: usage.frameId } : {}),
      granularity: 'provider-call',
      provider: 'anthropic',
      inputTokens: usage.prompt_tokens,
      inputCachedTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
      outputTokens: usage.completion_tokens,
      reasoningTokens: 0,
      totalTokens: usage.total_tokens,
      costUnits: usage.total_tokens,
      costUnitType: 'tokens',
    };
  }

  /**
   * Emit context window update after Anthropic usage tracking.
   *
   * Uses `cache_read_input_tokens` for the cached token count and
   * defaults to `DEFAULT_CONTEXT_WINDOW_SIZE` (200,000) for Claude models.
   * @param payload - Anthropic usage event payload
   */
  protected async emitUsageContextWindowUpdate(payload: Record<string, unknown>): Promise<void> {
    const usage = payload as UsageEvent;
    await this.emitContextWindowUpdate({
      currentTokens:
        usage.total_tokens ??
        usage.prompt_tokens +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          usage.completion_tokens,
      maxTokens: this.getContextWindowSize() ?? DEFAULT_CONTEXT_WINDOW_SIZE,
      cachedTokens: usage.cache_read_input_tokens,
    });
  }

  /**
   * Reserve a block index for a tool call using Anthropic's provider-native block index.
   *
   * Anthropic sends `blockIndex` on each tool call entry in the tool_calls event.
   * Using the provider index preserves the correct ordering in persisted step history,
   * even when tool_calls events arrive before text step events.
   * @param tc - Anthropic tool call entry (carries `blockIndex`)
   * @returns Provider-native block index from the tool call
   */
  protected reserveToolCallBlockIndex(tc: ToolCall): number {
    return tc.blockIndex;
  }

  /**
   * Reconcile internal block index after emitting a tool call step.
   *
   * Advances the internal block index counter to stay ahead of the provider-native
   * index, so subsequent text/reasoning steps don't reuse stale indices.
   * @param blockIndex - The provider block index just emitted
   */
  protected afterToolCallStepEmitted(blockIndex: number): void {
    this.reconcileInternalBlockIndex(blockIndex);
  }

  /**
   * Return the fallback block index when no map entry exists for a toolCallId.
   *
   * Allocates the current block index and immediately increments the counter to keep
   * block indices monotonic and non-negative.
   * @returns Current block index (before increment)
   */
  protected getFallbackToolCompletedBlockIndex(): number {
    const blockIndex = this.getBlockIndex();
    this.incrementBlockIndex();
    return blockIndex;
  }

  /**
   * Reconcile internal block index after emitting a tool_completed step.
   *
   * Ensures the internal counter is ahead of the resolved block index so later
   * text/reasoning steps receive fresh, non-conflicting indices.
   * @param resolvedBlockIndex - The block index used for this tool's step.finished
   */
  protected afterToolCompletedStepEmitted(resolvedBlockIndex: number): void {
    this.reconcileInternalBlockIndex(resolvedBlockIndex);
  }

  /**
   * Build the reasoning `SessionMessageBlock` from an Anthropic reasoning_complete payload.
   *
   * Includes the `signature` field in block metadata when present. Anthropic requires
   * the signature for native history round-trip (persisted extended thinking blocks
   * must include the signature for subsequent API calls).
   * @param payload - Anthropic reasoning complete event payload
   * @returns Reasoning block with optional signature metadata
   */
  protected buildReasoningBlock(payload: Record<string, unknown>): SessionMessageBlock {
    const { content, signature } = payload as { content: string; signature?: string };
    if (signature === undefined) {
      return { type: 'reasoning', content };
    }
    return { type: 'reasoning', content, metadata: { signature } };
  }

  /**
   * Wire tool approval RPC from connector's scoped bus to global AgentSubjects.toolApprove.
   *
   * Uses centralized tool-handling helper for consistent approval flow.
   * Uses lazy callback to resolve adapterSessionId at request time (not constructor time).
   * @param connector - The AnthropicSdkConnector to wire RPC from
   */
  protected wireToolApprovalRpc(connector: AnthropicSdkConnector): void {
    this.addConnectorWiringCleanup(
      registerToolApprovalHandler(
        connector,
        async () => ({
          adapterId: this.adapterId,
          adapterName: this.adapterName,
          agentId: this.agentId,
          adapterSessionId: await this.getAdapterSessionId(),
          // sessionId is always set for agents running within a session; asserted here
          // as the Zod schema on AgentSubjects.toolApprove enforces it at runtime.
          sessionId: this.sessionId!,
        }),
        this.config.globalBus,
      ),
    );
  }
}
