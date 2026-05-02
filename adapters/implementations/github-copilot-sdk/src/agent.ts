import { AIAgent, type NormalizedCallUsage } from '@makaio/ai-adapters-core';
import { GitHubCopilotConnector } from './connector.js';
import {
  type GitHubCopilotConnectorBus,
  GitHubCopilotConnectorSubjects,
  type AssistantMessageEvent,
  type AssistantUsageEvent,
  type AssistantReasoningEvent,
  type SessionEventOf,
  type SessionUsageInfoEvent,
} from './namespaces/index.js';
import { registerToolApprovalHandler } from './tool-handling.js';
import QuickLRU from 'quick-lru';
import { AgentSubjects, type SessionMessageBlock } from '@makaio/contracts';
import { EventContext } from '@makaio/core';

// Type aliases for specific event types using SessionEventOf helper
type SessionErrorEvent = SessionEventOf<'session.error'>;
type SessionTruncationEvent = SessionEventOf<'session.truncation'>;
type AssistantReasoningDeltaEvent = SessionEventOf<'assistant.reasoning_delta'>;
type ToolUserRequestedEvent = SessionEventOf<'tool.user_requested'>;
type ToolExecutionStartEvent = SessionEventOf<'tool.execution_start'>;
type ToolExecutionPartialResultEvent = SessionEventOf<'tool.execution_partial_result'>;
type ToolExecutionCompleteEvent = SessionEventOf<'tool.execution_complete'>;

type ToolCall = {
  toolName: string;
  toolCallId: string;
  args?: Record<string, unknown>;
};
/**
 * GitHub Copilot Agent - Middle layer between AIAdapter and GitHubCopilotConnector.
 *
 * Responsibilities:
 * 1. Create and configure the GitHubCopilotConnector
 * 2. Wire connector's scoped bus events to global agent.* subjects
 * 3. Auto-enrich payloads with AgentContext via emitGlobal()
 *
 * Event Flow:
 * - GitHubCopilotConnector emits to scoped bus (adapter:github-copilot.*)
 * - GitHubCopilotAgent subscribes to connector's bus and emits to global bus (agent.*)
 * - Downstream consumers subscribe to normalized agent.* subjects
 */
export class GitHubCopilotAgent extends AIAgent<GitHubCopilotConnectorBus, GitHubCopilotConnector> {
  private toolCalls = new QuickLRU<string, ToolCall>({ maxSize: 100 });

  /** Track toolCallId to blockIndex for correlation between step.started and step.finished */
  private toolBlockIndexMap = new Map<string, number>();

  protected wireEvents(connector: GitHubCopilotConnector) {
    // Wire connector events to global agent.* subjects
    this.wireConnectorEvents(connector);

    // Wire tool approval RPC: forward can_use_tool to global AgentSubjects.toolApprove
    this.wireToolApprovalRpc(connector);
  }

  /**
   * Wire connector's bus events to global agent.* subjects.
   *
   * Subscribes to GitHubCopilotConnectorSubjects.* on the connector's bus
   * and emits to AgentSubjects.* on the global bus.
   * @param connector - The GitHubCopilotConnector to wire events from
   */
  private wireConnectorEvents(connector: GitHubCopilotConnector): void {
    this.wireSdkEvents();
    this.wireSessionLifecycleEvents(connector);
    this.wireMessageEvents(connector);
    this.wireToolEvents(connector);
    this.wireContextWindowTracking(connector);
  }

  /**
   * Wire session/turn lifecycle events.
   * @param connector - The GitHubCopilotConnector to wire events from
   */
  private wireSessionLifecycleEvents(connector: GitHubCopilotConnector): void {
    // assistant.turn_start -> agent.started
    this.subscribeConnector(connector, GitHubCopilotConnectorSubjects.assistant.turn_start, async () => {
      this.toolBlockIndexMap.clear();
      await this.emitStart();
    });

    // session.error -> agent.error + agent.complete (maintains lifecycle invariant)
    this.subscribeConnector(
      connector,
      GitHubCopilotConnectorSubjects.session.error,
      async (ctx: EventContext<SessionErrorEvent>) => {
        const data = ctx.payload.data;

        return this.emitError({
          error: data.message,
        });
      },
    );
  }

  /**
   * Wire assistant message events (text and reasoning).
   *
   * Note: The SDK fires `assistant.message` and `assistant.reasoning` once per block
   * with complete content (no delta events for text). Each event emits a paired
   * step.started/step.finished to maintain lifecycle invariants.
   * @param connector - The GitHubCopilotConnector to wire events from
   */
  private wireMessageEvents(connector: GitHubCopilotConnector): void {
    // assistant.message -> agent.message + step events (fires once with complete content)
    this.subscribeConnector(
      connector,
      GitHubCopilotConnectorSubjects.assistant.message,
      async (ctx: EventContext<AssistantMessageEvent>) => {
        const data = ctx.payload.data;
        const content = (data?.content as string) || '';

        // Emit paired step.started/step.finished for each complete text block
        await this.emitStepStarted('text', { type: 'text' });

        // Emit agent.message
        await this.emitGlobal(AgentSubjects.message, { content });

        // Emit step.finished for text content
        await this.emitStepFinished('text', { type: 'text', content });
      },
    );

    // assistant.reasoning -> agent.reasoning + step events (fires once with complete content)
    this.subscribeConnector(
      connector,
      GitHubCopilotConnectorSubjects.assistant.reasoning,
      async (ctx: EventContext<AssistantReasoningEvent>) => {
        const data = ctx.payload.data;
        const content = data?.content || '';

        // Emit paired step.started/step.finished for each complete reasoning block
        await this.emitStepStarted('reasoning', { type: 'reasoning' });

        // Emit agent.reasoning
        await this.emitGlobal(AgentSubjects.reasoning, { content });

        // Emit step.finished for reasoning content
        await this.emitStepFinished('reasoning', { type: 'reasoning', content });
      },
    );

    // assistant.reasoning_delta -> agent.reasoning_delta
    this.subscribeConnector(
      connector,
      GitHubCopilotConnectorSubjects.assistant.reasoning_delta,
      async (ctx: EventContext<AssistantReasoningDeltaEvent>) => {
        const data = ctx.payload.data;
        const deltaContent = data?.deltaContent || '';

        // Emit reasoning delta
        await this.emitGlobal(AgentSubjects.reasoning_delta, {
          content: deltaContent,
        });
      },
    );
  }

  /**
   * Register a tool call and emit step.started + tool.use events.
   * Shared by tool.user_requested and tool.execution_start handlers.
   * @param data - Tool call data with toolCallId, toolName, and arguments
   */
  private async registerToolCall(data: { toolCallId: string; toolName: string; arguments?: unknown }): Promise<void> {
    const rawArgs = data?.arguments;
    const args =
      rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
        ? (rawArgs as Record<string, unknown>)
        : { value: rawArgs };

    const toolCall = { toolName: data.toolName, args, toolCallId: data.toolCallId };
    this.toolCalls.set(data.toolCallId, toolCall);

    // Reserve blockIndex and emit step.started
    const blockIndex = this.getBlockIndex();
    this.toolBlockIndexMap.set(data.toolCallId, blockIndex);
    const toolCallContent: SessionMessageBlock = {
      type: 'tool_call',
      toolCallId: data.toolCallId,
      name: data.toolName,
      args,
    };
    await this.emitStepStarted(
      'tool_use',
      { type: 'tool_use', toolName: data.toolName, toolCallId: data.toolCallId },
      toolCallContent,
    );
    this.incrementBlockIndex();

    // Emit tool.use (intent)
    await this.emitGlobal(AgentSubjects.tool.use, toolCall);
  }

  /**
   * Wire tool-related events.
   * @param connector - The GitHubCopilotConnector to wire events from
   */
  private wireToolEvents(connector: GitHubCopilotConnector): void {
    // tool.user_requested -> register tool call (step.started + tool.use)
    this.subscribeConnector(
      connector,
      GitHubCopilotConnectorSubjects.tool.user_requested,
      async (ctx: EventContext<ToolUserRequestedEvent>) => {
        await this.registerToolCall(ctx.payload.data);
      },
    );

    // tool.execution_start -> agent.tool.started (+ register if not already cached)
    // Note: tool.user_requested may not fire for auto-approved tools
    this.subscribeConnector(
      connector,
      GitHubCopilotConnectorSubjects.tool.execution_start,
      async (ctx: EventContext<ToolExecutionStartEvent>) => {
        const data = ctx.payload.data;
        // If tool.user_requested didn't fire, register the tool call now
        if (!this.toolCalls.has(data.toolCallId)) {
          await this.registerToolCall(data);
        }
        // Always emit tool.started (execution began)
        await this.emitGlobal(AgentSubjects.tool.started, data);
      },
    );

    // tool.execution_partial_result -> agent.tool.output
    this.subscribeConnector(
      connector,
      GitHubCopilotConnectorSubjects.tool.execution_partial_result,
      async (ctx: EventContext<ToolExecutionPartialResultEvent>) => {
        const p = ctx.payload;

        await this.emitGlobal(AgentSubjects.tool.output, {
          output: p.data.partialOutput,
          toolCallId: p.data.toolCallId,
        });
      },
    );

    // tool.execution_complete -> agent.tool.completed + step.finished
    this.subscribeConnector(
      connector,
      GitHubCopilotConnectorSubjects.tool.execution_complete,
      (ctx: EventContext<ToolExecutionCompleteEvent>) => this.handleToolExecutionComplete(ctx.payload.data),
    );
  }

  /**
   * Handle tool execution completion - emit tool.completed and step.finished.
   * @param data - Tool execution complete data
   */
  private async handleToolExecutionComplete(data: { toolCallId: string; result?: unknown; success: boolean }) {
    const lastToolCall = this.toolCalls.get(data.toolCallId);
    if (!lastToolCall) return;

    await this.emitGlobal(AgentSubjects.tool.completed, {
      ...lastToolCall,
      result: (data?.result || {}) as Record<string, unknown>,
      success: data.success,
    });

    // Emit step.finished for tool execution using reserved blockIndex
    const blockIndex = this.toolBlockIndexMap.get(data.toolCallId);
    if (blockIndex === undefined) {
      console.warn(
        `[CopilotAdapter] toolCallId ${data.toolCallId} not found in toolBlockIndexMap - possible state mismatch`,
      );
    }
    const resolvedBlockIndex = blockIndex ?? -1;
    this.toolBlockIndexMap.delete(data.toolCallId);
    const output = typeof data.result === 'string' ? data.result : JSON.stringify(data.result || {});
    await this.emitGlobal(AgentSubjects.step.finished, {
      stepType: 'tool_use',
      blockIndex: resolvedBlockIndex,
      content: { type: 'tool_output', toolCallId: data.toolCallId, output, isError: !data.success },
    });
  }

  /**
   * Wire usage and context window tracking.
   *
   * Two sources for context window state:
   * - `session.usage_info`: authoritative per-turn snapshot (currentTokens = messages only, tokenLimit).
   *   Fires after every turn as an ephemeral event.
   * - `session.truncation`: fires only when history is truncated, provides post-truncation state.
   *
   * Note: `assistant.usage.inputTokens` is NOT used for context window estimates because it
   * reflects `prompt_tokens` from the LLM API call — which includes all tool definition schemas
   * (100+ built-in Copilot tools, ~270k tokens) in addition to the conversation history. Using
   * it as a context estimate would massively inflate the reported context window usage.
   * @param connector - The GitHubCopilotConnector to wire events from
   */
  private wireContextWindowTracking(connector: GitHubCopilotConnector): void {
    // Track billing usage from assistant.usage events (inputTokens, outputTokens, cost).
    // Does NOT emit context window update — see JSDoc above for why.
    this.subscribeConnector(
      connector,
      GitHubCopilotConnectorSubjects.assistant.usage,
      async (ctx: EventContext<AssistantUsageEvent>) => {
        const data = ctx.payload.data;

        const inputTokens = data.inputTokens ?? 0;
        const outputTokens = data.outputTokens ?? 0;
        const totalTokens = inputTokens + outputTokens;

        const normalized: NormalizedCallUsage = {
          provider: 'copilot',
          inputTokens,
          inputCachedTokens: data.cacheReadTokens ?? 0,
          outputTokens,
          // The Copilot SDK's assistant.usage event does not expose reasoning
          // token counts — the field is absent from the SDK type definitions.
          reasoningTokens: 0,
          totalTokens,
          costUnits: 1,
          costUnitType: 'requests',
        };
        await this.trackUsage(normalized);
      },
    );

    // Track context window from session.truncation events (when context fills up)
    this.subscribeConnector(
      connector,
      GitHubCopilotConnectorSubjects.session.truncation,
      async (ctx: EventContext<SessionTruncationEvent>) => {
        const data = ctx.payload.data;

        // Emit context window update with actual values from truncation event
        await this.emitContextWindowUpdate({
          currentTokens: data.postTruncationTokensInMessages,
          maxTokens: data.tokenLimit,
        });
      },
    );

    // Track context window from session.usage_info events (accurate per-turn snapshot).
    // session.usage_info carries tokenLimit and currentTokens directly from the SDK,
    // providing authoritative context window state without requiring truncation to occur.
    this.subscribeConnector(
      connector,
      GitHubCopilotConnectorSubjects.session.usage_info,
      async (ctx: EventContext<SessionUsageInfoEvent>) => {
        const data = ctx.payload.data;
        await this.emitContextWindowUpdate({
          currentTokens: data.currentTokens,
          maxTokens: data.tokenLimit,
        });
      },
    );
  }

  /**
   * Wire tool approval RPC from connector's scoped bus to global AgentSubjects.toolApprove.
   *
   * Uses centralized tool-handling helper for consistent approval flow.
   * Uses lazy callback to resolve adapterSessionId at request time (not constructor time).
   * @param connector - The GitHubCopilotConnector to wire RPC from
   */
  private wireToolApprovalRpc(connector: GitHubCopilotConnector): void {
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
  /**
   * Wire SDK catch-all events to semantic subjects.
   * Routes sdk.event to typed semantic subjects based on event type.
   */
  private wireSdkEvents(): void {
    this.createConnectorEventMapping(GitHubCopilotConnectorSubjects.sdk.event, 'type', {
      'assistant.turn_start': GitHubCopilotConnectorSubjects.assistant.turn_start,
      'assistant.message': GitHubCopilotConnectorSubjects.assistant.message,
      'assistant.reasoning': GitHubCopilotConnectorSubjects.assistant.reasoning,
      'assistant.reasoning_delta': GitHubCopilotConnectorSubjects.assistant.reasoning_delta,
      'assistant.turn_end': GitHubCopilotConnectorSubjects.assistant.turn_end,
      'assistant.usage': GitHubCopilotConnectorSubjects.assistant.usage,
      'session.truncation': GitHubCopilotConnectorSubjects.session.truncation,
      'session.usage_info': GitHubCopilotConnectorSubjects.session.usage_info,
      'session.error': GitHubCopilotConnectorSubjects.session.error,
      'tool.execution_start': GitHubCopilotConnectorSubjects.tool.execution_start,
      'tool.execution_partial_result': GitHubCopilotConnectorSubjects.tool.execution_partial_result,
      'tool.execution_complete': GitHubCopilotConnectorSubjects.tool.execution_complete,
      // NOTE: tool.user_requested needs special handling for toolCalls cache
      // but since wireToolEvents() already subscribes to the semantic subject,
      // we can use passthrough here too
      'tool.user_requested': GitHubCopilotConnectorSubjects.tool.user_requested,
    });
  }
}
