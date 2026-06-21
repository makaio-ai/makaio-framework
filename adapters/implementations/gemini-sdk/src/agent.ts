/* eslint max-lines: ["error", { "max": 450 }] */
import { AIAgent, type NormalizedCallUsage } from '@makaio/ai-adapters-core';
import { GeminiConnector } from './connector.js';
import {
  GeminiConnectorSubjects,
  type GeminiConnectorBus,
  type SdkAgentMessageChunk,
  type SdkAgentThoughtChunk,
} from './namespaces/index.js';
import { registerToolApprovalHandler } from './tool-handling.js';
import { AgentSubjects, type SessionMessageBlock, type StepType } from '@makaio/contracts';
import { EventContext } from '@makaio/core';
import { getContextWindowSize } from './models.js';

/**
 * Gemini Agent - Middle layer between AIAdapter and GeminiConnector.
 *
 * Responsibilities:
 * 1. Wire connector's scoped bus events to global agent.* subjects
 * 2. Auto-enrich payloads with AgentContext via emitGlobal()
 *
 * Event Flow:
 * - GeminiConnector emits ALL events to sdk.event (catch-all)
 * - GeminiAgent's wireSdkEvents() transforms to semantic subjects
 * - wireConnectorEvents() subscribes to semantic subjects and emits to global agent.*
 * - Downstream consumers subscribe to normalized agent.* subjects
 */
export class GeminiAgent extends AIAgent<GeminiConnectorBus, GeminiConnector> {
  /** Accumulated message content during streaming */
  private currentMessageContent = '';
  /** Accumulated reasoning content during streaming */
  private currentReasoningContent = '';
  /** Current step type for tracking content blocks */
  private currentStepType: StepType | null = null;
  /** Track whether text step.started was emitted (for step.finished on session end) */
  private textStepStarted = false;
  /** Reserved blockIndex for text step (set at step.started, used at step.finished) */
  private textBlockIndex: number | null = null;
  /** Track whether reasoning step.started was emitted (for step.finished on session end) */
  private reasoningStepStarted = false;
  /** Reserved blockIndex for reasoning step (set at step.started, used at step.finished) */
  private reasoningBlockIndex: number | null = null;
  /** Per-call tool metadata for correlating started/updated events safely under overlap. */
  private toolCallInfoMap = new Map<string, { name: string; args: Record<string, unknown> }>();
  /** Track toolCallId to blockIndex for correlation between step.started and step.finished */
  private toolBlockIndexMap = new Map<string, number>();
  /**
   * Reset all per-turn state (accumulators, step tracking, block indices).
   * Called on session.created (first turn) and turn.turn_started (subsequent turns).
   */
  private resetTurnState(): void {
    this.currentMessageContent = '';
    this.currentReasoningContent = '';
    this.currentStepType = null;
    this.toolCallInfoMap.clear();
    this.toolBlockIndexMap.clear();
    this.textStepStarted = false;
    this.textBlockIndex = null;
    this.reasoningStepStarted = false;
    this.reasoningBlockIndex = null;
  }

  /**
   * Wire all connector events.
   * Called by AIAgent.init() after connector creation.
   * @param connector - The GeminiConnector instance
   */
  protected wireEvents(connector: GeminiConnector): void {
    // Wire sdk.event catch-all to semantic subjects
    this.wireSdkEvents();
    // Wire semantic subjects to global agent.* subjects
    this.wireConnectorEvents(connector);
    // Wire tool approval RPC: forward acp.tool_approval to global AgentSubjects.toolApprove
    this.wireToolApprovalRpc(connector);
  }

  /**
   * Wire sdk.event catch-all to semantic subjects.
   * Transforms discriminated union events to typed semantic subjects.
   */
  private wireSdkEvents(): void {
    this.createConnectorEventMapping(GeminiConnectorSubjects.sdk.event, 'type', {
      'session.created': GeminiConnectorSubjects.session.created,
      'session.completed': GeminiConnectorSubjects.session.completed,
      'session.finished': GeminiConnectorSubjects.session.finished,
      'session.error': GeminiConnectorSubjects.session.error,
      'agent.message.chunk': GeminiConnectorSubjects.agent.message.chunk,
      'agent.thought.chunk': GeminiConnectorSubjects.agent.thought.chunk,
      'agent.tool.started': GeminiConnectorSubjects.agent.tool.started,
      'agent.tool.updated': GeminiConnectorSubjects.agent.tool.updated,
    });
  }

  /**
   * Wire connector's semantic bus events to global agent.* subjects.
   *
   * Subscribes to GeminiSDKSubjects.* on the connector's scoped bus
   * and emits to AgentSubjects.* on the global bus.
   * @param connector - The GeminiConnector to wire events from
   */
  private wireConnectorEvents(connector: GeminiConnector): void {
    // session.created -> one-time initialization (do NOT emit agent.started here)
    // Note: turn.turn_started fires on ALL turns including the first, so we only
    // emit agent.started there to avoid duplicate emissions on first turn.
    this.subscribeConnector(connector, GeminiConnectorSubjects.session.created, async () => {
      this.resetTurnState();
    });

    // turn.turn_started -> reset per-turn state and emit agent.started
    this.subscribeConnector(connector, GeminiConnectorSubjects.turn.turn_started, async () => {
      this.resetTurnState();
      await this.emitStart();
    });

    // Wire streaming content events
    this.wireContentEvents(connector);

    // Wire tool lifecycle events
    this.wireToolEvents(connector);

    // Usage tracking and step.finished from session.finished
    this.subscribeConnector(connector, GeminiConnectorSubjects.session.finished, async (ctx) => {
      await this.handleSessionFinished(ctx.payload);
    });

    // session.completed -> emit agent.message with full turn content (parity with OpenAI/Copilot/Codex)
    this.subscribeConnector(connector, GeminiConnectorSubjects.session.completed, async (ctx) => {
      // Contract note: AgentSubjects.message currently expects a plain text string in `content`.
      await this.emitGlobal(AgentSubjects.message, { content: ctx.payload.message });
    });

    // Error events -> flush in-flight steps + agent.error
    // flushAccumulatedSteps maintains the lifecycle invariant that every step.started
    // has a matching step.finished — normally called from session.finished, but errors
    // skip that event so we must flush here too.
    this.subscribeConnector(connector, GeminiConnectorSubjects.session.error, async (ctx) => {
      await this.flushAccumulatedSteps();
      await this.emitError({ error: ctx.payload.error });
    });
  }

  /**
   * Wire streaming content events (message and thought chunks).
   * @param connector - The GeminiConnector to wire events from
   */
  private wireContentEvents(connector: GeminiConnector): void {
    // Agent message chunk -> agent.message_delta + accumulate
    this.subscribeConnector(
      connector,
      GeminiConnectorSubjects.agent.message.chunk,
      async (ctx: EventContext<SdkAgentMessageChunk>) => {
        const payload = ctx.payload;
        const text = payload.content.type === 'text' ? payload.content.text : `[${payload.content.type}]`;

        // Emit step.started on first chunk if not already started
        if (!this.textStepStarted) {
          this.textStepStarted = true;
          this.textBlockIndex = this.getBlockIndex();
          this.currentStepType = 'text';
          this.currentMessageContent = '';
          await this.emitStepStarted('text', { type: 'text' });
          this.incrementBlockIndex(); // Reserve this slot
        }

        // Accumulate content
        this.currentMessageContent += text;

        // Emit streaming delta
        await this.emitGlobal(AgentSubjects.message_delta, { text });
      },
    );

    // Agent thought chunk -> agent.reasoning_delta + accumulate
    this.subscribeConnector(
      connector,
      GeminiConnectorSubjects.agent.thought.chunk,
      async (ctx: EventContext<SdkAgentThoughtChunk>) => {
        const payload = ctx.payload;
        const content = payload.content.type === 'text' ? payload.content.text : `[${payload.content.type}]`;

        // Emit step.started on first chunk if not already started
        if (!this.reasoningStepStarted) {
          this.reasoningStepStarted = true;
          this.reasoningBlockIndex = this.getBlockIndex();
          this.currentStepType = 'reasoning';
          this.currentReasoningContent = '';
          await this.emitStepStarted('reasoning', { type: 'reasoning' });
          this.incrementBlockIndex(); // Reserve this slot
        }

        // Accumulate content
        this.currentReasoningContent += content;

        // Emit streaming delta
        await this.emitGlobal(AgentSubjects.reasoning_delta, { content });
      },
    );
  }

  /**
   * Wire tool lifecycle events (started and updated).
   * @param connector - The GeminiConnector to wire events from
   */
  private wireToolEvents(connector: GeminiConnector): void {
    // Tool started -> agent.tool.use (intent) AND agent.tool.started (execution began) AND step.started
    this.subscribeConnector(connector, GeminiConnectorSubjects.agent.tool.started, async (ctx) => {
      const payload = ctx.payload;
      const toolName = payload.title ?? 'unknown';
      const args = (payload.rawInput ?? {}) as Record<string, unknown>;

      // Track tool call metadata by call ID so overlapping calls do not clobber each other.
      this.toolCallInfoMap.set(payload.toolCallId, { name: toolName, args });
      this.currentStepType = 'tool_use';

      // Reserve blockIndex for this tool call and emit step.started
      const blockIndex = this.getBlockIndex();
      this.toolBlockIndexMap.set(payload.toolCallId, blockIndex);
      const toolCallContent: SessionMessageBlock = {
        type: 'tool_call',
        toolCallId: payload.toolCallId,
        name: toolName,
        args,
      };
      await this.emitStepStarted(
        'tool_use',
        { type: 'tool_use', toolName, toolCallId: payload.toolCallId },
        toolCallContent,
      );
      this.incrementBlockIndex(); // Reserve this slot

      // Emit tool.use (intent)
      await this.emitGlobal(AgentSubjects.tool.use, {
        toolName,
        args,
        toolCallId: payload.toolCallId,
      });

      // Emit tool.started (execution began)
      await this.emitGlobal(AgentSubjects.tool.started, {
        toolName,
        toolCallId: payload.toolCallId,
      });
    });

    // Tool updated -> agent.tool.completed AND step.finished with tool_output
    this.subscribeConnector(connector, GeminiConnectorSubjects.agent.tool.updated, async (ctx) => {
      const payload = ctx.payload;
      const success = payload.status === 'completed';

      // Emit step.finished with tool_output content using reserved blockIndex
      const blockIndex = this.toolBlockIndexMap.get(payload.toolCallId);
      if (blockIndex === undefined) {
        console.warn(
          `[GeminiAdapter] toolCallId ${payload.toolCallId} not found in toolBlockIndexMap - possible state mismatch`,
        );
      }
      const resolvedBlockIndex = blockIndex ?? -1;
      this.toolBlockIndexMap.delete(payload.toolCallId);
      const toolCallInfo = this.toolCallInfoMap.get(payload.toolCallId);
      this.toolCallInfoMap.delete(payload.toolCallId);
      // Extract output from the event payload (string or serialize if object)
      const rawOutput = payload.output;
      const output =
        typeof rawOutput === 'string'
          ? rawOutput
          : rawOutput !== null && rawOutput !== undefined
            ? JSON.stringify(rawOutput)
            : '';

      const toolOutputContent: SessionMessageBlock = {
        type: 'tool_output',
        toolCallId: payload.toolCallId,
        output,
        isError: !success,
      };
      await this.emitGlobal(AgentSubjects.step.finished, {
        stepType: 'tool_use',
        blockIndex: resolvedBlockIndex,
        content: toolOutputContent,
      });

      // Emit tool.completed with result
      await this.emitGlobal(AgentSubjects.tool.completed, {
        toolName: toolCallInfo?.name ?? 'unknown',
        args: toolCallInfo?.args,
        result:
          rawOutput !== null && rawOutput !== undefined && typeof rawOutput === 'object'
            ? (rawOutput as Record<string, unknown>)
            : { output },
        success,
        toolCallId: payload.toolCallId,
      });

      this.currentStepType = null;
    });
  }

  /**
   * Flush any accumulated step content by emitting step.finished events.
   * Called at session end to complete any in-flight text/reasoning steps.
   *
   * Note: We emit step.finished even if content is empty to maintain the lifecycle
   * invariant that every step.started has a matching step.finished. Downstream
   * consumers (PostStep hooks, storage) depend on paired events.
   */
  private async flushAccumulatedSteps(): Promise<void> {
    // Emit step.finished for text (if step.started was emitted)
    if (this.textStepStarted && this.textBlockIndex !== null) {
      const textContent: SessionMessageBlock = {
        type: 'text',
        content: this.currentMessageContent, // May be empty string
      };
      await this.emitGlobal(AgentSubjects.step.finished, {
        stepType: 'text',
        blockIndex: this.textBlockIndex,
        content: textContent,
      });
    }

    // Emit step.finished for reasoning (if step.started was emitted)
    if (this.reasoningStepStarted && this.reasoningBlockIndex !== null) {
      const reasoningContent: SessionMessageBlock = {
        type: 'reasoning',
        content: this.currentReasoningContent, // May be empty string
      };
      await this.emitGlobal(AgentSubjects.step.finished, {
        stepType: 'reasoning',
        blockIndex: this.reasoningBlockIndex,
        content: reasoningContent,
      });
    }

    // Reset step tracking
    this.textStepStarted = false;
    this.textBlockIndex = null;
    this.reasoningStepStarted = false;
    this.reasoningBlockIndex = null;
  }

  // NOTE: do NOT change without explicit human approval
  /* eslint complexity: ["error", { "max": 22 }] */
  /**
   * Handle session.finished event - emit step.finished for accumulated content and track usage.
   * @param payload - Session finished event payload
   */
  private async handleSessionFinished(payload: {
    model?: string;
    reason?: string;
    usageMetadata?: {
      promptTokenCount?: number;
      cachedContentTokenCount?: number;
      candidatesTokenCount?: number;
      thoughtsTokenCount?: number;
      totalTokenCount?: number;
      trafficType?: string;
    };
  }): Promise<void> {
    await this.flushAccumulatedSteps();

    // Track usage
    const normalized: NormalizedCallUsage = {
      provider: 'gemini',
      inputTokens: payload.usageMetadata?.promptTokenCount ?? 0,
      inputCachedTokens: payload.usageMetadata?.cachedContentTokenCount ?? 0,
      outputTokens: payload.usageMetadata?.candidatesTokenCount ?? 0,
      reasoningTokens: payload.usageMetadata?.thoughtsTokenCount ?? 0,
      totalTokens: payload.usageMetadata?.totalTokenCount ?? 0,
      costUnits: 1,
      costUnitType: 'requests',
      serviceTier: payload.usageMetadata?.trafficType,
    };
    await this.trackUsage(normalized);

    const usageMetadata = payload.usageMetadata;
    if (usageMetadata) {
      const currentTokens = (usageMetadata.promptTokenCount ?? 0) + (usageMetadata.candidatesTokenCount ?? 0);
      const modelName = payload.model ?? this.connector.model;
      const maxTokens = getContextWindowSize(modelName);

      await this.emitContextWindowUpdate({
        currentTokens,
        maxTokens,
        cachedTokens: usageMetadata.cachedContentTokenCount,
      });
    }
    // Reset accumulators after turn completes
    this.currentMessageContent = '';
    this.currentReasoningContent = '';
    this.currentStepType = null;
  }

  /**
   * Wire tool approval RPC from connector's scoped bus to global AgentSubjects.toolApprove.
   *
   * Uses centralized tool-handling helper for consistent approval flow.
   * Uses lazy callback to resolve adapterSessionId at request time (not constructor time).
   * @param connector - The GeminiConnector to wire RPC from
   */
  private wireToolApprovalRpc(connector: GeminiConnector): void {
    this.addConnectorWiringCleanup(
      registerToolApprovalHandler(
        connector,
        async () => {
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
        },
        this.globalBus,
      ),
    );
  }
}
