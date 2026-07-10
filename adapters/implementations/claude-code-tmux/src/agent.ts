/**
 * ClaudeCodeTmuxAgent — event routing layer for the tmux adapter.
 *
 * Wires connector lifecycle events (emitted on the adapter's scoped bus)
 * to global `agent.*` subjects. Unlike the SDK-based Claude adapters that
 * process streaming content blocks, the tmux adapter is hook-driven — turn
 * state transitions come from Claude Code's hook system, not a JSON stream.
 *
 * Responsibilities:
 * 1. Emit `agent.started` when a turn begins (`turn_started`)
 * 2. Emit `agent.message` with the assistant's response (`turn_completed`)
 * 3. Emit `agent.step.started` / `agent.step.finished` with tool metadata
 *    from PreToolUse/PostToolUse hooks (`tool_use.started` / `tool_use.finished`)
 * 4. Tool approval is handled externally via PreToolUse hooks (hook bridge in
 *    tests, CLI kernel in production) — no connector-bus RPC wiring needed.
 *
 * Event Flow:
 * ```
 * Claude Code hooks → TmuxSession → Connector → scoped bus (adapter:claude-code-tmux.*)
 *                                                          ↓
 *                                              ClaudeCodeTmuxAgent.wireEvents()
 *                                                          ↓
 *                                              global bus (agent.*)
 * ```
 * @packageDocumentation
 */

import {
  AIAgent,
  type AgentStartResult,
  type NormalizedCallUsage,
  type NormalizedMessageInput,
  type StartAgentOptions,
} from '@makaio/ai-adapters-core';
import type { ClaudeCodeStatuslineRawPayload } from '@makaio/client-claude-code';
import { ClaudeCodeClientSubjects } from '@makaio/client-claude-code/runtime';
import { AgentSubjects, type MessageInput } from '@makaio/contracts';
import { ClientSubjects } from '@makaio/contracts/client';
import { isRecord } from '@makaio/utils';
import { ClaudeCodeTmuxConnector } from './connector.js';
import { ClaudeCodeTmuxConnectorSubjects, type ClaudeCodeTmuxConnectorBus } from './namespace/index.js';

/**
 * Agent for the Claude Code tmux adapter.
 *
 * Subscribes to the connector's scoped subjects and translates them into
 * global `agent.*` subjects consumed by the framework.
 *
 * Claude Code owns its own session history and context management, so this
 * agent returns `true` from `supportsNativeResume()` — Makaio does NOT inject
 * prior message history into follow-up turns.
 */
export class ClaudeCodeTmuxAgent extends AIAgent<ClaudeCodeTmuxConnectorBus, ClaudeCodeTmuxConnector> {
  /**
   * Deduplication keys for statusline usage events within the current turn.
   * Cleared at `turn_started` so each turn tracks only its own emissions.
   */
  private readonly statuslineUsageKeys = new Set<string>();
  private lastRuntimeObservationKey: string | undefined;

  /**
   * Claude Code manages its own conversation context across turns.
   * @returns true — native resume is preferred over fresh-with-history
   */
  protected override supportsNativeResume(): boolean {
    return true;
  }

  /**
   * Wire connector's scoped events to global agent.* subjects.
   *
   * Called automatically during `init()` and on connector swap.
   * @param connector - The ClaudeCodeTmuxConnector to wire events from
   */
  protected override wireEvents(connector: ClaudeCodeTmuxConnector): void {
    this.wireTurnLifecycleEvents(connector);
    this.wireToolUseEvents(connector);
    this.wireStatuslineUsageEvents(connector);
  }

  /**
   * Initialize the connector and publish runtime evidence once the tmux-backed
   * Claude Code session ID is known.
   * @param options - Optional initialization options.
   * @returns Confirmed adapter session ID, or `undefined` for unconfirmed fork sessions.
   */
  public override async initialize(options?: StartAgentOptions): Promise<string | undefined> {
    const confirmedId = await super.initialize(options);
    this.observeCurrentRuntime();
    return confirmedId;
  }

  /**
   * Start the first turn and publish runtime evidence for the tmux-backed
   * Claude Code session.
   * @param message - Initial user message.
   * @param options - Optional start options.
   * @returns Agent start result from the connector.
   */
  public override async start(
    message: NormalizedMessageInput | MessageInput,
    options?: StartAgentOptions,
  ): Promise<AgentStartResult> {
    const result = await super.start(message, options);
    this.observeCurrentRuntime();
    return result;
  }

  /**
   * Wire turn start/finish events.
   *
   * - `turn_started` → `emitStart()` to signal the orchestration layer
   * - `turn_completed` → `AgentSubjects.message` for session persistence.
   *   Completion emission (`agent.complete`) is handled automatically by
   *   the base class lifecycle tracker when the connector calls
   *   `handle.markCompleted()`.
   * @param connector - The connector to subscribe on
   */
  private wireTurnLifecycleEvents(connector: ClaudeCodeTmuxConnector): void {
    this.subscribeConnector(connector, ClaudeCodeTmuxConnectorSubjects.turn.turn_started, async () => {
      this.statuslineUsageKeys.clear();
      await this.emitStart();
    });

    this.subscribeConnector(connector, ClaudeCodeTmuxConnectorSubjects.turn.turn_completed, async (ctx) => {
      await this.emitGlobal(AgentSubjects.message, { content: ctx.payload.message });
    });
  }

  /**
   * Wire tool use events from PreToolUse/PostToolUse hooks.
   *
   * The connector emits `tool_use.started` and `tool_use.finished` with
   * tool metadata (toolName, toolUseId) extracted from hook payloads.
   * These are translated to schema-valid `agent.step.*` events.
   *
   * Claude Code owns tool execution internally; the adapter emits correlation
   * subjects from hook metadata so framework observers can follow the tool
   * lifecycle without executing the tool itself.
   * @param connector - The connector to subscribe on
   */
  private wireToolUseEvents(connector: ClaudeCodeTmuxConnector): void {
    this.subscribeConnector(connector, ClaudeCodeTmuxConnectorSubjects.tool_use.started, async (ctx) => {
      const { toolName, toolUseId, toolInput } = ctx.payload;
      const args = normalizeToolInput(toolInput);
      await this.emitToolUse(toolName, args, toolUseId);
      await this.emitStepStarted('tool_use', { type: 'tool_use', toolName, toolCallId: toolUseId });
    });

    this.subscribeConnector(connector, ClaudeCodeTmuxConnectorSubjects.tool_use.finished, async (ctx) => {
      const { toolName, toolUseId, toolResult, isError } = ctx.payload;
      const output = normalizeToolOutput(toolResult);
      const resolved = await this.emitToolOutput(output, { nativeId: toolUseId, toolName });
      await this.emitStepFinished('tool_use', {
        type: 'tool_output',
        toolCallId: resolved.toolCallId,
        output,
        isError: isError ?? false,
      });
    });
  }

  /**
   * Wire Claude Code statusline payloads into agent usage subjects.
   *
   * The statusline bridge emits raw client-native payloads. This adapter owns
   * the correlation back to the running agent via Claude's session_id.
   * @param connector - The connector whose adapter session ID identifies the
   *   Claude Code statusline stream.
   */
  private wireStatuslineUsageEvents(connector: ClaudeCodeTmuxConnector): void {
    const adapterSessionId = connector.adapterSessionId;
    if (!adapterSessionId) {
      return;
    }

    const cleanup = this.globalBus.on(
      ClaudeCodeClientSubjects.statusline.received,
      async ({ payload }) => {
        await this.handleStatuslineUsage(payload);
      },
      { filter: { session_id: adapterSessionId } },
    );
    this.addConnectorWiringCleanup(cleanup);
  }

  /**
   * Normalize one raw Claude Code statusline payload into agent usage signals.
   * @param payload - Raw statusline payload from Claude Code.
   */
  private async handleStatuslineUsage(payload: ClaudeCodeStatuslineRawPayload): Promise<void> {
    const contextWindow = payload.context_window;
    if (!contextWindow) {
      return;
    }

    const inputTokens = contextWindow.current_usage?.input_tokens;
    const outputTokens = contextWindow.current_usage?.output_tokens;
    if (inputTokens !== undefined && outputTokens !== undefined && this.shouldEmitUsage(payload)) {
      const cacheReadTokens = contextWindow.current_usage?.cache_read_input_tokens ?? 0;
      const cacheWriteTokens = contextWindow.current_usage?.cache_creation_input_tokens;
      const normalized: NormalizedCallUsage = {
        provider: 'anthropic',
        // Lossy statusline observation of the latest request — deduplicated
        // via shouldEmitUsage, never a running total.
        granularity: 'latest-request-gauge',
        inputTokens,
        inputCachedTokens: cacheReadTokens,
        cacheWriteTokens,
        outputTokens,
        reasoningTokens: 0,
        totalTokens: inputTokens + cacheReadTokens + outputTokens,
        costUnits: 1,
        costUnitType: 'requests',
      };
      // `cost.total_cost_usd` is cumulative for the Claude Code session, not this request.
      await this.trackUsage(normalized);
    }

    const currentTokens = (contextWindow.total_input_tokens ?? 0) + (contextWindow.total_output_tokens ?? 0);
    const maxTokens = contextWindow.context_window_size ?? this.getContextWindowSize() ?? 200_000;
    await this.emitContextWindowUpdate({
      currentTokens,
      maxTokens,
      cachedTokens: contextWindow.current_usage?.cache_read_input_tokens,
    });
  }

  /**
   * Prevent duplicate billing events from repeated statusline renders for the
   * same per-request token counts.
   *
   * The key combines the four `current_usage.*` token counts (the fields that
   * appear in the emitted {@link NormalizedCallUsage} payload) with the
   * cumulative context-window totals, plus `session_id` for scoping. The
   * cumulative totals grow with every real API request, so two distinct
   * requests that happen to produce identical per-request token counts still
   * get distinct keys and are both counted. `cost.total_cost_usd` is
   * intentionally excluded — it is a cumulative session total that can change
   * between statusline re-renders of the SAME request, which would cause the
   * same usage event to fire more than once.
   * @param payload - Raw statusline payload from Claude Code.
   * @returns True when usage should be emitted.
   */
  private shouldEmitUsage(payload: ClaudeCodeStatuslineRawPayload): boolean {
    const contextWindow = payload.context_window;
    const usage = contextWindow?.current_usage;
    const key = [
      payload.session_id ?? '',
      usage?.input_tokens ?? '',
      usage?.output_tokens ?? '',
      usage?.cache_read_input_tokens ?? '',
      usage?.cache_creation_input_tokens ?? '',
      contextWindow?.total_input_tokens ?? '',
      contextWindow?.total_output_tokens ?? '',
    ].join(':');
    if (this.statuslineUsageKeys.has(key)) {
      return false;
    }
    this.statuslineUsageKeys.add(key);
    return true;
  }

  /**
   * Publish best-effort runtime evidence for the current tmux-backed connector.
   */
  private observeCurrentRuntime(): void {
    const adapterSessionId = this.connector?.adapterSessionId;
    if (!adapterSessionId) {
      return;
    }

    const clientId = this.config.clientId ?? 'claude-code';
    const observationKey = `${clientId}:${this.sessionId ?? ''}:${adapterSessionId}`;
    if (observationKey === this.lastRuntimeObservationKey) {
      return;
    }
    this.lastRuntimeObservationKey = observationKey;

    void this.globalBus
      .requestOptional(ClientSubjects.runtime.observe, {
        clientId,
        source: { layer: 'adapter', producer: 'claude-code-tmux' },
        observedAt: Date.now(),
        adapterSessionId,
        ...(this.sessionId !== undefined && { sessionId: this.sessionId }),
        cwd: this.connector.cwd,
      })
      .then((result) => {
        if (!result.handled && this.lastRuntimeObservationKey === observationKey) {
          this.lastRuntimeObservationKey = undefined;
        }
      })
      .catch(() => {
        if (this.lastRuntimeObservationKey === observationKey) {
          this.lastRuntimeObservationKey = undefined;
        }
      });
  }
}

/**
 * Normalize Claude Code hook tool input into the existing agent.tool.use args schema.
 * @param toolInput - Raw PreToolUse input payload.
 * @returns Record-shaped tool arguments.
 */
function normalizeToolInput(toolInput: unknown): Record<string, unknown> {
  if (isRecord(toolInput)) {
    return toolInput;
  }
  if (toolInput === undefined) {
    return {};
  }
  return { input: toolInput };
}

/**
 * Normalize Claude Code hook tool result/error into the existing tool output schema.
 * @param toolResult - Raw PostToolUse result or error payload.
 * @returns String output for agent.tool.output and tool_output step content.
 */
function normalizeToolOutput(toolResult: unknown): string {
  if (toolResult === undefined || toolResult === null) {
    return '';
  }
  if (typeof toolResult === 'string') {
    return toolResult;
  }
  try {
    return JSON.stringify(toolResult);
  } catch {
    return String(toolResult);
  }
}
