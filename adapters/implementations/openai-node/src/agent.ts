import { BaseStreamAgent, type StreamAdapterSubjectSpec } from '@makaio/ai-adapters-stream-session';
import type { NormalizedCallUsage } from '@makaio/ai-adapters-core';
import { OpenAINodeConnector } from './connector.js';
import {
  OpenAINodeConnectorSubjects,
  type OpenAINodeConnectorBus,
  type ToolCall,
  UsageEvent,
} from './namespaces/index.js';
import { registerToolApprovalHandler } from './tool-handling.js';
import type { SessionMessageBlock } from '@makaio/contracts';

/**
 * Subject spec for the OpenAI Node adapter, satisfying `StreamAdapterSubjectSpec`.
 *
 * Scoped to the OpenAI Node connector namespace. Passed as the `TSpec` type parameter
 * to `BaseStreamAgent` so shared wire methods resolve handler types correctly.
 */
type OpenAISubjectSpec = StreamAdapterSubjectSpec<typeof OpenAINodeConnectorSubjects.chunk.$meta.namespace>;

/**
 * OpenAI Agent - Middle layer between AIAdapter and OpenAINodeConnector.
 *
 * Responsibilities:
 * 1. Wire connector's scoped bus events to global agent.* subjects
 * 2. Auto-enrich payloads with AgentContext via emitGlobal()
 *
 * Event Flow:
 * - OpenAINodeConnector emits to semantic subjects (chunk, usage, etc.)
 * - OpenAIAgent subscribes to semantic subjects and emits to global bus (agent.*)
 * - Downstream consumers subscribe to normalized agent.* subjects
 *
 * Extends `BaseStreamAgent` which provides all shared wiring logic. This class only
 * implements the adapter-specific abstract hooks.
 */
export class OpenAIAgent extends BaseStreamAgent<OpenAINodeConnectorBus, OpenAINodeConnector, OpenAISubjectSpec> {
  // ---------------------------------------------------------------------------
  // Abstract hook implementations — OpenAI-specific
  // ---------------------------------------------------------------------------

  /**
   * Tier 1: Route sdk.event catch-all to typed semantic subjects.
   *
   * Uses `createConnectorEventMapping` for type-safe discriminated union routing.
   * Pattern matches codex-mcp: envelope `{ id, event }` with nestedMessageProp 'event'.
   */
  protected wireSdkEvents(): void {
    this.createConnectorEventMapping(
      OpenAINodeConnectorSubjects.sdk.event,
      'eventType',
      {
        chunk: OpenAINodeConnectorSubjects.chunk,
        usage: OpenAINodeConnectorSubjects.usage,
        tool_calls: OpenAINodeConnectorSubjects.tool_calls,
        message_complete: OpenAINodeConnectorSubjects.message_complete,
        reasoning_delta: OpenAINodeConnectorSubjects.reasoning_delta,
        reasoning_complete: OpenAINodeConnectorSubjects.reasoning_complete,
        agent_started: OpenAINodeConnectorSubjects.agent_started,
        agent_complete: OpenAINodeConnectorSubjects.agent_complete,
        error: OpenAINodeConnectorSubjects.error,
        tool_started: OpenAINodeConnectorSubjects.tool_started,
        tool_completed: OpenAINodeConnectorSubjects.tool_completed,
      },
      'event',
    );
  }

  /**
   * Return the OpenAI Node adapter's connector subject spec.
   *
   * Maps adapter subject constants to the `StreamAdapterSubjectSpec` interface used
   * by `BaseStreamAgent` to subscribe to semantic events.
   * @returns OpenAI-specific subject spec
   */
  protected getConnectorSubjects(): OpenAISubjectSpec {
    // Cast: each returned subject is an event subject (not a request), satisfying EventSubjectDef.
    // The full namespace record carries tool_approval (a request), which prevents structural
    // assignability at the SubjectDefinition meta level. The cast is safe because the
    // concrete subjects' payloads are all EventMessagePayload at their specific subject keys.
    return {
      chunk: OpenAINodeConnectorSubjects.chunk,
      usage: OpenAINodeConnectorSubjects.usage,
      toolCalls: OpenAINodeConnectorSubjects.tool_calls,
      reasoningComplete: OpenAINodeConnectorSubjects.reasoning_complete,
      messageComplete: OpenAINodeConnectorSubjects.message_complete,
      reasoningDelta: OpenAINodeConnectorSubjects.reasoning_delta,
      toolStarted: OpenAINodeConnectorSubjects.tool_started,
      toolCompleted: OpenAINodeConnectorSubjects.tool_completed,
      agentStarted: OpenAINodeConnectorSubjects.agent_started,
      agentComplete: OpenAINodeConnectorSubjects.agent_complete,
      error: OpenAINodeConnectorSubjects.error,
    } as OpenAISubjectSpec;
  }

  /**
   * Extract plain text from an OpenAI chunk event payload.
   *
   * OpenAI chunk events use the ChatCompletionChunk structure where text content
   * is at `choices[0].delta.content`.
   * @param payload - OpenAI chunk event payload
   * @returns The text content, or empty string when no content is present
   */
  protected extractChunkText(payload: Record<string, unknown>): string {
    const { choices } = payload as { choices?: Array<{ delta?: { content?: string | null } }> };
    return choices?.[0]?.delta?.content ?? '';
  }

  /**
   * Map an OpenAI usage event payload to the shared `NormalizedCallUsage` format.
   *
   * Reads OpenAI-specific nested fields: `prompt_tokens_details.cached_tokens`
   * and `completion_tokens_details.reasoning_tokens`.
   * @param payload - OpenAI usage event payload
   * @returns Normalized usage metrics
   */
  protected extractUsagePayload(payload: Record<string, unknown>): NormalizedCallUsage {
    const usage = payload as UsageEvent;
    return {
      provider: 'openai',
      inputTokens: usage.prompt_tokens,
      inputCachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      outputTokens: usage.completion_tokens,
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
      totalTokens: usage.total_tokens,
      costUnits: usage.total_tokens,
      costUnitType: 'tokens',
    };
  }

  /**
   * Emit context window update after OpenAI usage tracking.
   *
   * Uses `prompt_tokens_details.cached_tokens` for the cached token count and
   * defaults to 128,000 tokens (standard GPT-4o context window).
   * @param payload - OpenAI usage event payload
   */
  protected async emitUsageContextWindowUpdate(payload: Record<string, unknown>): Promise<void> {
    const usage = payload as UsageEvent;
    // Formula: prompt_tokens + completion_tokens
    await this.emitContextWindowUpdate({
      currentTokens: usage.prompt_tokens + usage.completion_tokens,
      maxTokens: this.getContextWindowSize() ?? 128000,
      cachedTokens: usage.prompt_tokens_details?.cached_tokens,
    });
  }

  /**
   * Reserve a block index for a tool call using the local internal counter.
   *
   * OpenAI does not provide provider-native block indices on tool calls, so we
   * allocate the current counter value and increment to reserve the slot.
   * @param _tc - OpenAI tool call entry (blockIndex not used)
   * @returns Current block index (incremented after return by base class via `afterToolCallStepEmitted`)
   */
  protected reserveToolCallBlockIndex(_tc: ToolCall): number {
    return this.getBlockIndex();
  }

  /**
   * Increment the block index after emitting a tool call step.
   *
   * OpenAI uses the local counter, so we must explicitly reserve the slot by
   * incrementing after the step has been emitted.
   * @param _blockIndex - The block index just emitted (unused; counter manages state)
   */
  protected afterToolCallStepEmitted(_blockIndex: number): void {
    this.incrementBlockIndex();
  }

  /**
   * Return `-1` as the fallback block index when no map entry exists for a toolCallId.
   *
   * OpenAI uses a sentinel value of `-1` to indicate an unknown index, which is
   * distinguishable from any valid (non-negative) provider block index.
   * @returns `-1` sentinel value
   */
  protected getFallbackToolCompletedBlockIndex(): number {
    return -1;
  }

  /**
   * No-op: OpenAI does not need post-step index reconciliation.
   *
   * The internal block index was already incremented inside `afterToolCallStepEmitted`,
   * so no reconciliation is needed after tool_completed.
   * @param _resolvedBlockIndex - Unused
   */
  protected afterToolCompletedStepEmitted(_resolvedBlockIndex: number): void {
    // no-op: counter managed by reserveToolCallBlockIndex + afterToolCallStepEmitted
  }

  /**
   * Build the reasoning `SessionMessageBlock` from an OpenAI reasoning_complete payload.
   *
   * OpenAI reasoning events do not carry a `signature` field, so the block
   * contains only `{ type, content }` without metadata.
   * @param payload - OpenAI reasoning complete event payload
   * @returns Plain reasoning block without signature metadata
   */
  protected buildReasoningBlock(payload: Record<string, unknown>): SessionMessageBlock {
    const { content } = payload as { content: string };
    return { type: 'reasoning', content };
  }

  /**
   * Wire tool approval RPC from connector's scoped bus to global AgentSubjects.toolApprove.
   *
   * Uses centralized tool-handling helper for consistent approval flow.
   * Uses lazy callback to resolve adapterSessionId at request time (not constructor time).
   * @param connector - The OpenAINodeConnector to wire RPC from
   */
  protected wireToolApprovalRpc(connector: OpenAINodeConnector): void {
    this.addConnectorWiringCleanup(
      registerToolApprovalHandler(connector, async () => {
        if (this.sessionId == null) {
          throw new Error('Agent sessionId is required for tool approval');
        }
        return {
          adapterId: this.adapterId,
          adapterName: this.adapterName,
          agentId: this.agentId,
          adapterSessionId: await this.getAdapterSessionId(),
          sessionId: this.sessionId,
        };
      }),
    );
  }
}
