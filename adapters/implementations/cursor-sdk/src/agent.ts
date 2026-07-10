/**
 * Cursor SDK Agent — Event routing layer.
 *
 * Wires connector events (emitted on the CursorSdkBus) to global `agent.*` subjects.
 * Acts as the translation layer between Cursor's event semantics and Makaio's.
 *
 * Responsibilities:
 * 1. Wire connector scoped `adapter:cursorSdk:*` subjects to global `agent.*` subjects
 * 2. Emit `agent.started` on turn start (orchestration contract)
 * 3. Route streaming text/reasoning deltas to AgentSubjects.message_delta / reasoning_delta
 * 4. Emit `AgentSubjects.message` once at turn completion (session persistence)
 * 5. Route tool call events to the step lifecycle
 * 6. Track usage metrics and emit context-window updates
 * 7. Route tool approval to the global bus
 *
 * Event Flow:
 * - CursorSdkConnector emits to adapter:cursorSdk:* subjects (from Cursor SDK events)
 * - CursorSdkAgent routes to semantic subjects via wireEvents()
 * - Downstream consumers subscribe to normalized agent.* subjects
 * @packageDocumentation
 */

import { AIAgent } from '@makaio/ai-adapters-core';
import type { NormalizedCallUsage } from '@makaio/ai-adapters-core';
import { AgentSubjects } from '@makaio/contracts';
import type { CursorSdkBus } from './namespaces/index.js';
import { CursorSdkSubjects } from './namespaces/index.js';
import type { CursorSdkConnector } from './connector.js';
import { registerToolApprovalHandler } from './tool-handling.js';

/**
 * Cursor SDK raw usage shape as emitted by the connector on the `usage` subject.
 *
 * Typed locally to avoid a runtime dependency on the Cursor SDK peer in the agent layer.
 * Cursor SDK reports token usage per completed message or turn.
 */
export interface CursorRawUsage {
  /** Input (prompt) token count. */
  inputTokens: number;
  /** Output (completion) token count. */
  outputTokens: number;
  /** Cache read tokens. */
  cacheReadTokens?: number;
  /** Cache write tokens. */
  cacheWriteTokens?: number;
  /** Total token count (computed when not provided by the SDK). */
  totalTokens?: number;
  /** Per-category cost in USD, if provided by the SDK. */
  cost?: number;
}

/**
 * Type-guard: narrow an unknown value to CursorRawUsage.
 *
 * Validates the required numeric fields without importing from the Cursor SDK peer.
 * The Cursor SDK's turn-ended usage provides inputTokens, outputTokens,
 * cacheReadTokens, cacheWriteTokens — but NOT totalTokens.
 * @param value - Unknown value from the `usage` event payload
 * @returns True when `value` satisfies the CursorRawUsage shape
 */
function isCursorRawUsage(value: unknown): value is CursorRawUsage {
  if (typeof value !== 'object' || value === null) return false;
  const u = value as Record<string, unknown>;
  return typeof u['inputTokens'] === 'number' && typeof u['outputTokens'] === 'number';
}

/**
 * Normalize a Cursor SDK usage payload to the shared `NormalizedCallUsage` format.
 *
 * Granularity is `turn-aggregate`: the Cursor SDK reports usage once per
 * completed message/turn and may fold several internal model calls into it.
 * `cost` is forwarded only when the SDK actually reports an amount — an
 * absent amount stays absent instead of being invented as `0`.
 *
 * Exported to make it independently testable.
 * @param usage - Raw usage payload narrowed by {@link isCursorRawUsage}
 * @returns Normalized usage metrics ready for `trackUsage()`
 */
export function normalizeCursorUsage(usage: CursorRawUsage): NormalizedCallUsage {
  const totalTokens = usage.totalTokens ?? usage.inputTokens + usage.outputTokens;
  return {
    granularity: 'turn-aggregate',
    provider: 'cursor-sdk',
    inputTokens: usage.inputTokens,
    inputCachedTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    outputTokens: usage.outputTokens,
    reasoningTokens: 0,
    totalTokens,
    costUnits: totalTokens,
    costUnitType: 'tokens',
    ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
  };
}

/**
 * Serialize a tool result without letting JSON limitations break event routing.
 * @param value - Raw value returned by the native tool bridge
 * @returns A string representation suitable for agent event payloads
 */
function stringifyToolOutput(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Convert Cursor SDK tool result to the plain string expected by Makaio step events.
 *
 * Cursor SDK surfaces structured tool results. The first TextContent entry's
 * `text` field is used; everything else is JSON-serialized as a fallback.
 *
 * Exported to make it independently testable.
 * @param rawResult - Cursor SDK tool result (structured result or raw output)
 * @returns String form used in `tool_output` step events
 */
export function normalizeToolOutput(rawResult: unknown): string {
  if (rawResult == null) return '';

  // Cursor SDK may surface tool results as content arrays: [{ type: 'text', text: '...' }]
  if (Array.isArray(rawResult)) {
    const textEntry = rawResult.find(
      (entry): entry is { type: string; text: string } =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as Record<string, unknown>)['type'] === 'text' &&
        typeof (entry as Record<string, unknown>)['text'] === 'string',
    );
    if (textEntry) return textEntry.text;
    return stringifyToolOutput(rawResult);
  }

  if (typeof rawResult === 'string') return rawResult;
  return stringifyToolOutput(rawResult);
}

/**
 * Normalize Cursor SDK tool arguments to the record shape used by agent.tool events.
 * @param rawArgs - Raw Cursor SDK tool arguments
 * @returns Record arguments when available
 */
function normalizeToolArgs(rawArgs: unknown): Record<string, unknown> | undefined {
  return typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)
    ? (rawArgs as Record<string, unknown>)
    : undefined;
}

/**
 * Normalize Cursor SDK tool result to the agent.tool.completed schema.
 * @param rawResult - Raw Cursor SDK tool result
 * @param output - String output already emitted to agent.tool.output
 * @returns Result payload for agent.tool.completed
 */
function normalizeToolCompletedResult(rawResult: unknown, output: string): Record<string, unknown> | string {
  if (typeof rawResult === 'string') return rawResult;
  if (typeof rawResult === 'object' && rawResult !== null && !Array.isArray(rawResult)) {
    return rawResult as Record<string, unknown>;
  }
  return { output };
}

/**
 * Cursor SDK Agent — middle layer between `CursorSdkAdapter` and `CursorSdkConnector`.
 *
 * Subscribes to scoped CursorSdkBus subjects emitted by CursorSdkConnector and
 * translates them into global `agent.*` subjects consumed by the framework.
 *
 * Cursor owns its conversation history across turns, so this agent returns `true`
 * from `supportsNativeResume()` — Makaio does NOT inject prior message history
 * into follow-up turns.
 */
export class CursorSdkAgent extends AIAgent<CursorSdkBus, CursorSdkConnector> {
  /**
   * Wire all CursorSdkConnector events to global agent.* subjects.
   *
   * Called automatically during init() and connector swap.
   * @param connector - The CursorSdkConnector instance to wire events from
   */
  protected override wireEvents(connector: CursorSdkConnector): void {
    this.wireTurnLifecycleEvents(connector);
    this.wireMessageEvents(connector);
    this.wireToolEvents(connector);
    this.wireUsageTracking(connector);
    this.wireToolApprovalRpc(connector);
  }

  /**
   * Cursor SDK owns session history across turns, so native resume is preferred
   * over fresh-with-history on subsequent turns.
   * @returns true — Cursor manages its own conversation context
   */
  protected override supportsNativeResume(): boolean {
    return true;
  }

  /**
   * Wire turn lifecycle events to global agent.* subjects.
   *
   * - `agent_started` → `emitStart()` to emit `agent.started`; model comes from the
   *   connector (not the event payload) per the base-class contract
   * - `agent_complete` → emit `agent.message` for session persistence (turn end)
   * - `error` → stash error metadata via `emitError()` for the next `emitCompletion`
   * @param connector - The CursorSdkConnector to subscribe on
   */
  private wireTurnLifecycleEvents(connector: CursorSdkConnector): void {
    this.subscribeConnector(connector, CursorSdkSubjects.agent_started, async (_ctx) => {
      await this.emitStart();
    });

    this.subscribeConnector(connector, CursorSdkSubjects.agent_complete, async (ctx) => {
      const result = ctx.payload.result;
      let text = '';
      if (typeof result === 'string') {
        text = result;
      } else if (result != null && typeof result === 'object' && 'text' in result) {
        const candidate = (result as Record<string, unknown>)['text'];
        text = typeof candidate === 'string' ? candidate : '';
      }
      if (text) {
        await this.emitGlobal(AgentSubjects.message, { content: text });
      }
    });

    this.subscribeConnector(connector, CursorSdkSubjects.error, async (ctx) => {
      const { error } = ctx.payload;
      const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
      this.emitError({ error: message });
    });
  }

  /**
   * Wire streaming text and reasoning events.
   *
   * Text blocks:
   * - `text_delta` → `agent.message_delta` for live UI streaming
   * - `text_complete` → step lifecycle (started + finished).
   *   `agent.message` is emitted once at `agent_complete` (turn end), not per text block —
   *   aligned with pi-sdk and other adapters that emit it only at turn completion.
   *
   * Reasoning (thinking) blocks:
   * - `thinking_delta` → `agent.reasoning_delta` for live UI streaming
   * - `thinking_complete` → step lifecycle (started + finished) + `agent.reasoning` for storage.
   * @param connector - The CursorSdkConnector to subscribe on
   */
  private wireMessageEvents(connector: CursorSdkConnector): void {
    // --- Text streaming ---
    this.subscribeConnector(connector, CursorSdkSubjects.text_delta, async (ctx) => {
      await this.emitGlobal(AgentSubjects.message_delta, { text: ctx.payload.delta });
    });

    this.subscribeConnector(connector, CursorSdkSubjects.text_complete, async (ctx) => {
      const { text } = ctx.payload;
      await this.emitStepStarted('text', { type: 'text' });
      await this.emitStepFinished('text', { type: 'text', content: text });
    });

    // --- Reasoning streaming ---
    this.subscribeConnector(connector, CursorSdkSubjects.thinking_delta, async (ctx) => {
      await this.emitGlobal(AgentSubjects.reasoning_delta, { content: ctx.payload.delta });
    });

    this.subscribeConnector(connector, CursorSdkSubjects.thinking_complete, async (ctx) => {
      const { text } = ctx.payload;
      await this.emitStepStarted('reasoning', { type: 'reasoning' });
      await this.emitStepFinished('reasoning', { type: 'reasoning', content: text });
      await this.emitGlobal(AgentSubjects.reasoning, { content: text });
    });
  }

  /**
   * Wire tool execution events to the global agent.* step lifecycle.
   *
   * - `tool_started` → `emitToolUse()` for correlation tracking + `emitStepStarted('tool_use')`
   * - `tool_completed` → `emitStepFinished('tool_use')` with normalized output + `emitToolOutput()`
   * @param connector - The CursorSdkConnector to subscribe on
   */
  private wireToolEvents(connector: CursorSdkConnector): void {
    this.subscribeConnector(connector, CursorSdkSubjects.tool_started, async (ctx) => {
      const { toolName, toolCallId, args } = ctx.payload;
      const normalizedArgs = normalizeToolArgs(args);
      await this.emitToolUse(toolName, normalizedArgs, toolCallId);
      await this.emitGlobal(AgentSubjects.tool.started, { toolName, toolCallId });
      await this.emitStepStarted('tool_use', { type: 'tool_use', toolName, toolCallId });
    });

    this.subscribeConnector(connector, CursorSdkSubjects.tool_completed, async (ctx) => {
      const { toolName, toolCallId, result, isError } = ctx.payload;
      const output = normalizeToolOutput(result);

      await this.emitStepFinished('tool_use', {
        type: 'tool_output',
        toolCallId,
        output,
        isError,
      });

      const resolved = await this.emitToolOutput(output, { nativeId: toolCallId, toolName });
      await this.emitGlobal(AgentSubjects.tool.completed, {
        toolName: resolved.toolName,
        args: resolved.args,
        result: normalizeToolCompletedResult(result, output),
        success: !isError,
        toolCallId: resolved.toolCallId,
      });
    });
  }

  /**
   * Wire token usage events to the framework's usage tracking infrastructure.
   *
   * Cursor SDK reports usage via the `usage` subject after each message completes.
   * The `usage` field is typed as `unknown` in the namespace to avoid hard-coupling
   * to the Cursor SDK peer type. A type-guard narrows it to `CursorRawUsage` before
   * normalization; unknown shapes log a warning and are skipped.
   *
   * Normalization is delegated to {@link normalizeCursorUsage}, which declares
   * the `turn-aggregate` granularity and forwards `cost` only when reported.
   * @param connector - The CursorSdkConnector to subscribe on
   */
  private wireUsageTracking(connector: CursorSdkConnector): void {
    this.subscribeConnector(connector, CursorSdkSubjects.usage, async (ctx) => {
      const { usage } = ctx.payload;

      if (!isCursorRawUsage(usage)) {
        console.warn('[CursorSdkAgent] Received usage event with unexpected shape; skipping.');
        return;
      }

      const normalized = normalizeCursorUsage(usage);

      await this.trackUsage(normalized);

      const currentTokens = normalized.totalTokens;
      const maxTokens = this.getContextWindowSize() ?? 200_000;
      await this.emitContextWindowUpdate({
        currentTokens,
        maxTokens,
        cachedTokens: normalized.inputCachedTokens,
      });
    });
  }

  /**
   * Wire tool approval RPC from the connector's scoped `tool_approval` subject
   * to the global `AgentSubjects.toolApprove`.
   *
   * Uses `registerToolApprovalHandler` from tool-handling.ts for consistent
   * approval flow. The lazy callback resolves `adapterSessionId` at request time
   * via `getAdapterSessionId()` to avoid the race condition where the session
   * hasn't started yet at wire time.
   *
   * `sessionId` is always set when running within a Makaio session; the assertion
   * here surfaces a configuration error early rather than producing a silent
   * approval failure.
   * @param connector - The CursorSdkConnector to wire the RPC handler on
   */
  private wireToolApprovalRpc(connector: CursorSdkConnector): void {
    this.addConnectorWiringCleanup(
      registerToolApprovalHandler(
        connector,
        async () => {
          if (this.sessionId == null) {
            throw new Error('[CursorSdkAgent] sessionId is required for tool approval');
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
