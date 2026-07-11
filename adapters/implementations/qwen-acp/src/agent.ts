/**
 * Qwen ACP Agent - Event routing layer.
 *
 * Wires connector events to global agent.* subjects.
 * Auto-enriches payloads with AgentContext via emitGlobal().
 *
 * Responsibilities:
 * 1. Wire connector's scoped bus events to global agent.* subjects
 * 2. Emit `agent.started` on turn_started (orchestration contract)
 * 3. Route text and reasoning deltas to AgentSubjects.message_delta / reasoning_delta
 * 4. Emit `AgentSubjects.message` when turn text completes (session persistence)
 * 5. Route tool call events to AgentSubjects.tool.use / step lifecycle
 * 6. Track usage metrics and context-window updates
 * 7. Route tool approval to global bus
 *
 * Event Flow:
 * - QwenAcpConnector emits to adapter:qwen-acp:* subjects
 * - QwenAcpAgent routes to semantic subjects via wireEvents()
 * - Downstream consumers subscribe to normalized agent.* subjects
 * @packageDocumentation
 */

import { AIAgent } from '@makaio/ai-adapters-core';
import type { NormalizedCallUsage } from '@makaio/ai-adapters-core';
import { AgentSubjects } from '@makaio/contracts';
import { QwenAcpConnector } from './connector.js';
import { QwenAcpSubjects } from './namespaces/index.js';
import type { QwenAcpBus } from './namespaces/index.js';
import { registerToolApprovalHandler } from './tool-handling.js';

/**
 * Convert ACP tool output payloads into the plain string expected by Makaio step events.
 * @param rawOutput - ACP tool output payload
 * @returns String form used in `tool_output` events
 */
export function normalizeToolOutput(rawOutput: unknown): string {
  if (rawOutput == null) return '';
  return typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput);
}

/**
 * Qwen ACP Agent - Middle layer between AIAdapter and QwenAcpConnector.
 *
 * Responsibilities:
 * 1. Wire connector's scoped bus events to global agent.* subjects
 * 2. Auto-enrich payloads with AgentContext via emitGlobal()
 * 3. Route tool approval from scoped bus to global AgentSubjects.toolApprove
 *
 * Event Flow:
 * - QwenAcpConnector emits to adapter:qwen-acp:* subjects
 * - QwenAcpAgent routes to semantic subjects via wireEvents()
 * - Downstream consumers subscribe to normalized agent.* subjects
 */
export class QwenAcpAgent extends AIAgent<QwenAcpBus, QwenAcpConnector> {
  /**
   * Wire adapter-specific connector events to global agent.* subjects.
   *
   * Called automatically during init() and connector swap.
   * @param connector - The QwenAcpConnector to wire events from
   */
  protected wireEvents(connector: QwenAcpConnector): void {
    this.wireTurnLifecycleEvents(connector);
    this.wireMessageEvents(connector);
    this.wireToolEvents(connector);
    this.wireUsageTracking(connector);
    this.wireToolApprovalRpc(connector);
  }

  /**
   * Wire turn lifecycle events to global agent.* subjects.
   *
   * Subscribes to `turn_started` so that `agent.started` is emitted at the beginning
   * of each turn, satisfying the orchestration contract shared by all adapters.
   * @param connector - The QwenAcpConnector to wire events from
   */
  private wireTurnLifecycleEvents(connector: QwenAcpConnector): void {
    this.subscribeConnector(connector, QwenAcpSubjects.turn_started, async () => {
      await this.emitStart();
    });
  }

  /**
   * Wire streaming text and reasoning delta events.
   *
   * Maps scoped session update subjects to global agent.* subjects
   * with automatic AgentContext enrichment.
   * @param connector - The QwenAcpConnector to wire events from
   */
  private wireMessageEvents(connector: QwenAcpConnector): void {
    this.subscribeConnector(connector, QwenAcpSubjects.session_update_message_chunk, async (ctx) => {
      await this.emitGlobal(AgentSubjects.message_delta, { text: ctx.payload.delta });
    });

    this.subscribeConnector(connector, QwenAcpSubjects.session_update_thought_chunk, async (ctx) => {
      await this.emitGlobal(AgentSubjects.reasoning_delta, { content: ctx.payload.delta });
    });

    // `turn_text_completed` is emitted directly on the bus by the connector (not via
    // connector.emit()), so the payload carries `agentId` explicitly — no Forbid conflict.
    // Subscribe via the connector's scoped bus so cleanup is handled by the wiring lifecycle.
    this.subscribeConnector(connector, QwenAcpSubjects.turn_text_completed, async (ctx) => {
      await this.emitGlobal(AgentSubjects.message, { content: ctx.payload.text });
    });
  }

  /**
   * Wire tool call events to the global agent.* step lifecycle.
   *
   * Maps ACP tool_call → tool.use + step.started and
   * tool_call_update (completed/failed) → step.finished.
   * @param connector - The QwenAcpConnector to wire events from
   */
  private wireToolEvents(connector: QwenAcpConnector): void {
    this.subscribeConnector(connector, QwenAcpSubjects.session_update_tool_call, async (ctx) => {
      const { messageId, toolCallId, title, rawInput } = ctx.payload;
      const args =
        typeof rawInput === 'object' && rawInput !== null ? (rawInput as Record<string, unknown>) : undefined;
      await this.emitToolUse(messageId, title, args, toolCallId);
      await this.eventBridge.emitStepStartedForMessage(messageId, 'tool_use', {
        type: 'tool_use',
        toolName: title,
        toolCallId,
      });
    });

    this.subscribeConnector(connector, QwenAcpSubjects.session_update_tool_call_update, async (ctx) => {
      const { messageId, toolCallId, status, rawOutput } = ctx.payload;
      if (status !== 'completed' && status !== 'failed') return;

      const isError = status === 'failed';
      const output = normalizeToolOutput(rawOutput);
      await this.eventBridge.emitStepFinishedForMessage(messageId, 'tool_use', {
        type: 'tool_output',
        toolCallId,
        output,
        isError,
      });
    });
  }

  /**
   * Wire usage tracking events.
   *
   * Per-turn token usage is extracted from `agent_message_chunk._meta.usage` by the
   * connector and forwarded as a `session_update_usage` event. The base
   * AIAgent.trackUsage() handles dual emission to both AgentSubjects.usage and
   * adapter session usage subjects.
   * @param connector - The QwenAcpConnector to wire events from
   */
  private wireUsageTracking(connector: QwenAcpConnector): void {
    this.subscribeConnector(connector, QwenAcpSubjects.session_update_usage, async (ctx) => {
      const { inputTokens, outputTokens, totalTokens, thoughtTokens, cachedReadTokens } = ctx.payload;

      const normalized: NormalizedCallUsage = {
        provider: 'qwen',
        granularity: 'turn-aggregate',
        inputTokens: inputTokens ?? 0,
        inputCachedTokens: cachedReadTokens ?? 0,
        outputTokens: outputTokens ?? 0,
        reasoningTokens: thoughtTokens ?? 0,
        totalTokens: totalTokens ?? (inputTokens ?? 0) + (outputTokens ?? 0),
        costUnits: (inputTokens ?? 0) + (outputTokens ?? 0),
        costUnitType: 'tokens',
      };
      await this.trackUsage(normalized);

      // Emit context window update alongside usage — conformance tests expect this
      // after every turn. Use token counts from the usage payload as current occupancy
      // and the model registry's context window size as the max.
      const currentTokens = normalized.totalTokens;
      const maxTokens = this.getContextWindowSize() ?? 1_000_000;
      await this.emitContextWindowUpdate({ currentTokens, maxTokens, cachedTokens: normalized.inputCachedTokens });
    });

    // Context-window capacity is also reported via the ACP `usage_update` notification
    // (separate from per-turn token splits). Forward to agent.contextWindow.updated
    // with more accurate size/used values when available.
    this.subscribeConnector(connector, QwenAcpSubjects.session_update_context_window, async (ctx) => {
      const { size, used } = ctx.payload;
      await this.emitContextWindowUpdate({ currentTokens: used, maxTokens: size, cachedTokens: 0 });
    });
  }

  /**
   * Wire tool approval RPC from connector's scoped bus to global AgentSubjects.toolApprove.
   *
   * Uses `registerToolApprovalHandler` from tool-handling.ts for consistent approval flow.
   * Note: adapterSessionId may be undefined at wire time — the lazy callback resolves it
   * at request time via connector.getAdapterSessionId() to avoid the race condition.
   * sessionId is always set for agents running within a session; asserted here as the
   * Zod schema on AgentSubjects.toolApprove enforces it at runtime.
   * @param connector - The QwenAcpConnector to wire RPC from
   */
  private wireToolApprovalRpc(connector: QwenAcpConnector): void {
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
