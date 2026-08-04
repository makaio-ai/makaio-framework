// NOTE: do NOT change the eslint override on the next line without explicit human approval
/* eslint max-lines: ["error", { "max": 450 }] */
import { AIAgent, processDiscriminatedItems, AIAgentConnector } from '@makaio/ai-adapters-core';
import type { OnOptions } from '@makaio/bus-core';
import type { HandlerForSubjectDefinition, ScopedSubjectDefinition } from '@makaio/core';
import type { ClaudeConnectorBus, ClaudeConnectorNamespace } from '../namespace/index.js';
import { registerToolApprovalHandler } from '../tool-handling/index.js';
import { AgentSubjects, type StepType, type SessionMessageBlock } from '@makaio/contracts';
import { CONTENT_BLOCK_HANDLERS } from '../content-block-handlers/index.js';
import {
  computeContextWindowTokens,
  normalizeTerminalResultUsage,
  type TerminalResultUsage,
} from './terminal-usage.js';
import { routeClaudeToolResults } from './claude-tool-results.js';

type ContentBlockStartPayload = {
  type: string;
  id?: string;
  name?: string;
};

type ContentBlockStartEvent = {
  type: 'content_block_start';
  index: number;
  content_block: ContentBlockStartPayload;
};

type ContentBlockStopEvent = {
  type: 'content_block_stop';
  index: number;
};

type ContentBlockDeltaPayload = {
  type: string;
  text?: string;
  thinking?: string;
  partial_json?: string;
};

type ContentBlockDeltaEvent = {
  type: 'content_block_delta';
  delta: ContentBlockDeltaPayload;
};

/**
 * Extract required correlation metadata from a tool_use block.
 * @param block - Stream content block payload
 * @returns Tool metadata when complete, otherwise null
 */
export function getToolUseMetadata(block: ContentBlockStartPayload): { toolCallId: string; toolName: string } | null {
  if (block.type !== 'tool_use') {
    return null;
  }

  if (!block.id || !block.name) {
    return null;
  }

  return { toolCallId: block.id, toolName: block.name };
}

/**
 * Claude Code Agent - Middle layer between AIAdapter and a ClaudeConnectorBus-compatible connector.
 *
 * Responsibilities:
 * 1. Wire connector's scoped bus events to global agent.* subjects
 * 2. Auto-enrich payloads with AgentContext via emitGlobal()
 *
 * Event Flow:
 * - Connector emits SDK events to scoped bus (adapter:claude-code.* or adapter:anthropic-sdk.*)
 * - ClaudeCodeAgent processes and routes to global bus (agent.*)
 * - Downstream consumers subscribe to normalized agent.* subjects
 *
 * Step Event Handling:
 * Unlike other adapters, Claude emits directly to AgentSubjects.step.started/finished
 * using the SDK-provided event.index rather than base class helpers. This is intentional:
 * the Claude SDK provides accurate block indices in content_block_start/stop events,
 * making manual tracking unnecessary. Other SDKs don't provide this, hence their adapters
 * use getBlockIndex()/incrementBlockIndex() for manual correlation.
 *
 * Namespace seam: subclasses implement getSubjects() to return the subjects for their
 * concrete adapter namespace (e.g. adapter:claude-code vs adapter:anthropic-sdk), so this
 * shared class is decoupled from any specific namespace registration.
 * @typeParam N - Namespace name string (e.g., 'adapter:claude-code')
 * @typeParam TConnector - The concrete connector type
 */
export abstract class ClaudeCodeAgent<
  N extends string = string,
  TConnector extends AIAgentConnector<ClaudeConnectorBus<N>> = AIAgentConnector<ClaudeConnectorBus<N>>,
> extends AIAgent<ClaudeConnectorBus<N>, TConnector> {
  /** @returns true — Claude SDK supports native session resume via Options.resume. */
  protected override supportsNativeResume(): boolean {
    return true;
  }

  /** @returns true — Claude adapters support native session fork via their connector start paths. */
  protected override supportsNativeFork(): boolean {
    return true;
  }

  /**
   * Return the connector namespace subjects for this adapter.
   * Implemented by concrete subclasses for their specific namespace (e.g. adapter:claude-code).
   * @returns Subjects from the concrete adapter namespace
   */
  protected abstract getSubjects(): ClaudeConnectorNamespace<N>['subjects'];

  /**
   * Current step type for correlating content_block_stop with its start.
   *
   * The Claude SDK processes content blocks sequentially within a turn,
   * so this single field is sufficient for tracking the current block's type.
   */
  private currentStepType: StepType = 'text';

  /** Accumulated text content during streaming */
  private currentTextContent = '';
  /** Accumulated reasoning content during streaming */
  private currentReasoningContent = '';
  /** Current tool call info for step.started content */
  private currentToolCall: { toolCallId: string; name: string; args: Record<string, unknown> } | null = null;
  /** toolCallId → blockIndex for correlation between step.started and step.finished */
  private toolBlockIndexMap = new Map<string, number>();
  /** Accumulated tool args JSON during streaming */
  private currentToolArgsJson = '';

  /**
   * Wire connector's bus events to global agent.* subjects and set up RPC handlers.
   *
   * Called by AIAgent.init() after connector is created.
   * @param connector - The connector to wire events from
   */
  protected wireEvents(connector: TConnector): void {
    // Cast to base type so subject subscriptions work without conditional type complications.
    // This is safe: TConnector extends AIAgentConnector<ClaudeConnectorBus<N>> and subjects
    // come from ClaudeConnectorNamespace<N>, so the namespace always matches at runtime.
    const baseConnector: AIAgentConnector<ClaudeConnectorBus<N>> = connector;
    this.wireConnectorEvents(baseConnector);
    this.wireToolApprovalRpc(connector);
  }

  /**
   * Subscribe to a Claude connector subject and register cleanup via addConnectorWiringCleanup.
   *
   * This bypasses subscribeConnector's conditional type constraint by accepting the base
   * AIAgentConnector\<ClaudeConnectorBus\<N\>\> type directly. The cleanup is registered
   * so it participates in connector swap lifecycle.
   * @param connector - Base connector typed to the shared Claude bus
   * @param subject - Subject from the Claude namespace
   * @param handler - Event handler
   * @param options - Optional subscription options
   */
  private subscribeClaudeConnector<Subject extends ScopedSubjectDefinition<N>>(
    connector: AIAgentConnector<ClaudeConnectorBus<N>>,
    subject: Subject,
    handler: HandlerForSubjectDefinition<Subject>,
    options?: OnOptions,
  ): void {
    this.addConnectorWiringCleanup(connector.on(subject, handler, options));
  }

  /**
   * Wire connector's scoped bus events to global agent.* subjects.
   *
   * Subscribes to the sdk.event catch-all subject and dispatches each message
   * to the appropriate typed handler by message type. The connector only emits
   * sdk.event; this single subscription fans out to all semantic handlers.
   * @param connector - Base connector typed to the shared Claude bus
   */
  private wireConnectorEvents(connector: AIAgentConnector<ClaudeConnectorBus<N>>): void {
    const s = this.getSubjects();

    // Subscribe to the sdk.event catch-all and dispatch by message type.
    // The connector only emits sdk.event (not the individual semantic subjects),
    // so all routing happens here. This mirrors the old wireSdkEvents + per-subject
    // wiring that existed before the shared extraction.
    this.subscribeClaudeConnector(connector, s.sdk.event, async (ctx) => {
      const msg = ctx.payload;
      const messageId = msg.originatingMessageId;
      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init') {
            await this.emitStart();
          }
          break;
        case 'assistant': {
          const content = msg.message?.content;
          if (!content) break;
          await processDiscriminatedItems(content, CONTENT_BLOCK_HANDLERS, async (subject, payload) => {
            if (subject.subject === 'tool.use') {
              if (messageId === undefined) return;
              const tp = payload as { toolName: string; args?: Record<string, unknown>; toolCallId: string };
              await this.emitToolUse(messageId, tp.toolName, tp.args, tp.toolCallId);
            } else if (subject.subject === 'tool.started' || subject.subject === 'tool.completed') {
              if (messageId === undefined) return;
              await this.emitGlobal(subject, { ...payload, messageId });
            } else {
              await this.emitGlobal(subject, payload);
            }
          });
          break;
        }
        case 'stream_event': {
          const event = msg.event;
          if (event.type === 'content_block_start') {
            await this.handleContentBlockStart(event, messageId);
          } else if (event.type === 'content_block_stop') {
            await this.handleContentBlockStop(event);
          } else if (event.type === 'content_block_delta') {
            await this.handleContentBlockDelta(event);
          }
          break;
        }
        case 'result':
          await this.handleResultEvent(msg);
          break;
        case 'user':
          await this.handleUserEvent(msg, messageId);
          break;
      }
    });
  }

  /**
   * Handle content_block_start event - reset accumulators and emit step.started.
   * @param event - The content_block_start event
   * @param messageId - Originating connector message identity
   */
  private async handleContentBlockStart(event: ContentBlockStartEvent, messageId?: string): Promise<void> {
    const block = event.content_block;
    const toolUseMetadata = getToolUseMetadata(block);
    const stepType: StepType =
      block.type === 'thinking' ? 'reasoning' : block.type === 'tool_use' ? 'tool_use' : 'text';

    this.currentStepType = stepType;
    this.currentTextContent = '';
    this.currentReasoningContent = '';
    this.currentToolArgsJson = '';
    this.currentToolCall = null;

    const blockData = toolUseMetadata
      ? { type: 'tool_use' as const, toolName: toolUseMetadata.toolName, toolCallId: toolUseMetadata.toolCallId }
      : block.type === 'tool_use'
        ? undefined
        : { type: stepType as 'reasoning' | 'text' };

    let content: SessionMessageBlock | undefined;
    if (toolUseMetadata) {
      this.currentToolCall = { toolCallId: toolUseMetadata.toolCallId, name: toolUseMetadata.toolName, args: {} };
      this.toolBlockIndexMap.set(toolUseMetadata.toolCallId, event.index);
      content = { type: 'tool_call', toolCallId: toolUseMetadata.toolCallId, name: toolUseMetadata.toolName, args: {} };
    }

    if (block.type === 'tool_use' && !toolUseMetadata) {
      console.warn('[ClaudeCodeAdapter] Received tool_use block without id or name; skipping tool correlation setup');
    }
    if (toolUseMetadata && messageId === undefined) {
      console.warn(
        '[ClaudeCodeAdapter] Received tool_use block without originating message identity; skipping tool events',
      );
      return;
    }

    await this.emitGlobal(AgentSubjects.step.started, {
      ...(messageId !== undefined && { messageId }),
      stepType,
      blockIndex: event.index,
      blockData,
      content,
    });

    if (toolUseMetadata) {
      await this.emitGlobal(AgentSubjects.tool.started, {
        ...(messageId !== undefined && { messageId }),
        toolName: toolUseMetadata.toolName,
        toolCallId: toolUseMetadata.toolCallId,
      });
    }
  }

  /**
   * Handle content_block_stop - emit step.finished or parse tool args.
   * @param event - The content_block_stop event
   */
  private async handleContentBlockStop(event: ContentBlockStopEvent): Promise<void> {
    if (this.currentStepType !== 'tool_use') {
      const content: SessionMessageBlock =
        this.currentStepType === 'text'
          ? { type: 'text', content: this.currentTextContent }
          : { type: 'reasoning', content: this.currentReasoningContent };
      await this.emitGlobal(AgentSubjects.step.finished, {
        stepType: this.currentStepType,
        blockIndex: event.index,
        content,
      });
    } else if (this.currentToolCall && this.currentToolArgsJson) {
      try {
        this.currentToolCall.args = JSON.parse(this.currentToolArgsJson);
      } catch {
        // Keep empty args if parse fails
      }
    }
  }

  /**
   * Handle content_block_delta - accumulate streaming content and emit deltas.
   * @param event - The content_block_delta event
   */
  private async handleContentBlockDelta(event: ContentBlockDeltaEvent): Promise<void> {
    const delta = event.delta;
    switch (delta.type) {
      case 'text_delta':
        this.currentTextContent += delta.text!;
        await this.emitGlobal(AgentSubjects.message_delta, { text: delta.text! });
        break;
      case 'thinking_delta':
        this.currentReasoningContent += delta.thinking!;
        await this.emitGlobal(AgentSubjects.reasoning_delta, { content: delta.thinking! });
        break;
      case 'input_json_delta':
        if ('partial_json' in delta) {
          this.currentToolArgsJson += delta.partial_json!;
        }
        break;
    }
  }

  /**
   * Handle result event usage metadata.
   * @param payload - Result event payload
   */
  private async handleResultEvent(payload: {
    subtype: string;
    is_error?: boolean;
    usage?: unknown;
    total_cost_usd?: number;
  }): Promise<void> {
    if (payload.usage) {
      const usage = payload.usage as TerminalResultUsage;
      await this.trackUsage(normalizeTerminalResultUsage(usage, payload.total_cost_usd));
      await this.emitContextWindowUpdate({
        currentTokens: computeContextWindowTokens(usage),
        maxTokens: this.getContextWindowSize() ?? 200_000,
        cachedTokens: usage.cache_read_input_tokens,
      });
    }
  }

  /**
   * Handle user event - emit tool.output, tool.completed, and step.finished.
   * @param payload - User event payload
   * @param messageId - Originating connector message identity
   */
  private async handleUserEvent(
    payload: {
      message?: { content?: unknown };
      tool_use_result?: { stdout?: string; stderr?: string } | string;
    },
    messageId?: string,
  ): Promise<void> {
    await routeClaudeToolResults({
      messageId,
      payload,
      resolveToolOutput: async (ownerId, output, nativeId) => await this.emitToolOutput(ownerId, output, { nativeId }),
      emitToolCompleted: async (result) => await this.emitGlobal(AgentSubjects.tool.completed, result),
      emitToolStepFinished: async (result) =>
        await this.emitGlobal(AgentSubjects.step.finished, {
          stepType: 'tool_use' as StepType,
          blockIndex: result.blockIndex,
          content: {
            type: 'tool_output',
            toolCallId: result.toolCallId,
            output: result.output,
            isError: result.isError,
          },
        }),
      consumeToolBlockIndex: (nativeId) => this.consumeToolBlockIndex(nativeId),
    });
  }

  /**
   * Return and clear the SDK block index retained for a tool result.
   * @param nativeId - Provider-native tool call identifier.
   * @returns Retained block index, or -1 when no index was recorded.
   */
  private consumeToolBlockIndex(nativeId: string | undefined): number {
    if (nativeId === undefined) return -1;
    const blockIndex = this.toolBlockIndexMap.get(nativeId);
    this.toolBlockIndexMap.delete(nativeId);
    if (blockIndex === undefined) {
      console.warn(
        `[ClaudeCodeAdapter] toolCallId ${nativeId} not found in toolBlockIndexMap - possible state mismatch`,
      );
    }
    return blockIndex ?? -1;
  }

  /**
   * Wire tool approval RPC from connector's scoped bus to global AgentSubjects.toolApprove.
   *
   * Uses lazy callback to resolve adapterSessionId at request time (not constructor time).
   * @param connector - The connector to wire RPC from
   */
  private wireToolApprovalRpc(connector: TConnector): void {
    this.addConnectorWiringCleanup(
      registerToolApprovalHandler(
        connector,
        this.getSubjects(),
        async () => ({
          adapterId: this.adapterId,
          adapterName: this.adapterName,
          agentId: this.agentId,
          adapterSessionId: await this.getAdapterSessionId(),
          // Intentionally asserted: sessionId is validated by registerToolApprovalHandler's
          // resolved-context guard before the payload reaches AgentSubjects.toolApprove.
          sessionId: this.sessionId!,
        }),
        this.globalBus,
      ),
    );
  }
}
