// NOTE: do NOT change without explicit human approval
/* eslint max-lines: ["error", { "max": 450 }] */
import {
  AIAgent,
  type NormalizedCallUsage,
  processDiscriminatedItems,
  AIAgentConnector,
} from '@makaio/ai-adapters-core';
import type { OnOptions } from '@makaio/bus-core';
import type { HandlerForSubjectDefinition, ScopedSubjectDefinition } from '@makaio/core';
import type { ClaudeConnectorBus, ClaudeConnectorNamespace } from '../namespace/index.js';
import { registerToolApprovalHandler } from '../tool-handling/index.js';
import { AgentSubjects, type StepType, type SessionMessageBlock } from '@makaio/contracts';
import { CONTENT_BLOCK_HANDLERS } from '../content-block-handlers/index.js';

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
  /**
   * Whether this adapter supports native session resume.
   * Claude SDK has first-class resume via Options.resume.
   * @returns true - Claude SDK supports native session resume
   */
  protected override supportsNativeResume(): boolean {
    return true;
  }

  /**
   * Return the connector namespace subjects for this adapter.
   *
   * Implemented by concrete subclasses to return the subjects registered
   * under their specific namespace name (e.g. adapter:claude-code).
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
  /** Track toolCallId to blockIndex for correlation between step.started and step.finished */
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
              const tp = payload as { toolName: string; args?: Record<string, unknown>; toolCallId: string };
              await this.emitToolUse(tp.toolName, tp.args, tp.toolCallId);
            } else {
              await this.emitGlobal(subject, payload);
            }
          });
          break;
        }
        case 'stream_event': {
          const event = msg.event;
          if (event.type === 'content_block_start') {
            await this.handleContentBlockStart(event);
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
          await this.handleUserEvent(msg);
          break;
      }
    });
  }

  /**
   * Handle content_block_start event - reset accumulators and emit step.started.
   * @param event - The content_block_start event
   */
  private async handleContentBlockStart(event: ContentBlockStartEvent): Promise<void> {
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

    await this.emitGlobal(AgentSubjects.step.started, { stepType, blockIndex: event.index, blockData, content });

    if (toolUseMetadata) {
      await this.emitGlobal(AgentSubjects.tool.started, {
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
   * Handle result event - track usage and emit completion or error.
   * @param payload - Result event payload
   */
  private async handleResultEvent(payload: {
    subtype: string;
    is_error?: boolean;
    usage?: unknown;
    total_cost_usd?: number;
  }): Promise<void> {
    if (payload.usage) {
      const usage = payload.usage as {
        input_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
        output_tokens: number;
        service_tier?: string;
      };

      const normalized: NormalizedCallUsage = {
        provider: 'anthropic',
        inputTokens: usage.input_tokens,
        inputCachedTokens: usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage.cache_creation_input_tokens,
        outputTokens: usage.output_tokens,
        reasoningTokens: 0,
        totalTokens: usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + usage.output_tokens,
        costUnits: 1,
        costUnitType: 'requests',
        cost: payload.total_cost_usd,
        serviceTier: usage.service_tier,
      };
      await this.trackUsage(normalized);

      const currentTokens =
        usage.input_tokens +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0) +
        usage.output_tokens;
      const contextWindowSize = this.getContextWindowSize() ?? 200_000;
      await this.emitContextWindowUpdate({
        currentTokens,
        maxTokens: contextWindowSize,
        cachedTokens: usage.cache_read_input_tokens,
      });
    }

    if (payload.subtype !== 'success' || payload.is_error) {
      await this.emitError({ error: payload.subtype });
    }
  }

  /**
   * Handle user event - emit tool.output, tool.completed, and step.finished.
   * @param payload - User event payload
   */
  private async handleUserEvent(payload: {
    message?: { content?: unknown };
    tool_use_result?: { stdout?: string; stderr?: string } | string;
  }): Promise<void> {
    const content = payload.message?.content;
    const contentBlocks = Array.isArray(content) ? content : content ? [content] : [];

    for (const block of contentBlocks) {
      if (typeof block === 'object' && block !== null) {
        const typedBlock = block as {
          type?: string;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
        };
        if (typedBlock.type === 'tool_result') {
          const nativeId = typedBlock.tool_use_id;
          const toolResult = payload.tool_use_result;
          let output: string | undefined;
          if (typeof toolResult === 'string') {
            output = toolResult;
          } else if (toolResult?.stdout || toolResult?.stderr) {
            output = [toolResult.stdout, toolResult.stderr].filter(Boolean).join('\n');
          }
          const resolved = await this.emitToolOutput(output ?? '', { nativeId });

          await this.emitGlobal(AgentSubjects.tool.completed, {
            toolName: resolved.toolName,
            args: resolved.args,
            result: { content: typedBlock.content ?? {} },
            success: !typedBlock.is_error,
            toolCallId: resolved.toolCallId,
          });

          let resolvedBlockIndex = -1;
          if (nativeId) {
            const blockIndex = this.toolBlockIndexMap.get(nativeId);
            if (blockIndex === undefined) {
              console.warn(
                `[ClaudeCodeAdapter] toolCallId ${nativeId} not found in toolBlockIndexMap - possible state mismatch`,
              );
            }
            resolvedBlockIndex = blockIndex ?? -1;
            this.toolBlockIndexMap.delete(nativeId);
          }
          await this.emitGlobal(AgentSubjects.step.finished, {
            stepType: 'tool_use' as StepType,
            blockIndex: resolvedBlockIndex,
            content: {
              type: 'tool_output',
              toolCallId: resolved.toolCallId,
              output: output ?? '',
              isError: typedBlock.is_error ?? false,
            },
          });
        }
      }
    }
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
