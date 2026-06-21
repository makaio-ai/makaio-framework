/**
 * Pi SDK Agent — Event routing layer.
 *
 * Wires connector events (emitted on the PiSdkBus) to global `agent.*` subjects.
 * Acts as the translation layer between Pi's event semantics and Makaio's.
 *
 * Responsibilities:
 * 1. Wire connector scoped `adapter:piSdk:*` subjects to global `agent.*` subjects
 * 2. Emit `agent.started` on turn start (orchestration contract)
 * 3. Route streaming text/reasoning deltas to AgentSubjects.message_delta / reasoning_delta
 * 4. Emit `AgentSubjects.message` when text or turn completes (session persistence)
 * 5. Route tool call events to the step lifecycle
 * 6. Track usage metrics and emit context-window updates
 * 7. Route tool approval to the global bus
 *
 * Event Flow:
 * - PiConnector emits to adapter:piSdk:* subjects (from Pi SDK AgentSessionEvent)
 * - PiAgent routes to semantic subjects via wireEvents()
 * - Downstream consumers subscribe to normalized agent.* subjects
 * @packageDocumentation
 */

import { AIAgent } from '@makaio/ai-adapters-core';
import type { NormalizedCallUsage } from '@makaio/ai-adapters-core';
import { AgentSubjects } from '@makaio/contracts';
import { PiConnector } from './connector.js';
import { PiSdkSubjects } from './namespaces/index.js';
import type { PiSdkBus } from './namespaces/index.js';
import { registerToolApprovalHandler } from './tool-handling.js';

/**
 * Pi SDK raw usage shape as emitted by the connector on the `usage` subject.
 *
 * Mirrors `Usage` from `@mariozechner/pi-ai` — typed locally to avoid a
 * runtime dependency on the Pi SDK peer in the agent layer.
 */
interface PiRawUsage {
  /** Input (prompt) token count */
  input: number;
  /** Output (completion) token count */
  output: number;
  /** Cache-read token count */
  cacheRead: number;
  /** Cache-write token count */
  cacheWrite: number;
  /** Total token count (input + output + cache) */
  totalTokens: number;
  /** Per-category costs in USD */
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

/**
 * Type-guard: narrow an unknown value to PiRawUsage.
 *
 * Validates the required numeric fields without importing from the Pi SDK peer.
 * @param value - Unknown value from the `usage` event payload
 * @returns True when `value` satisfies the PiRawUsage shape
 */
function isPiRawUsage(value: unknown): value is PiRawUsage {
  if (typeof value !== 'object' || value === null) return false;
  const u = value as Record<string, unknown>;
  const cost = typeof u['cost'] === 'object' && u['cost'] !== null ? (u['cost'] as Record<string, unknown>) : undefined;
  return (
    typeof u['input'] === 'number' &&
    typeof u['output'] === 'number' &&
    typeof u['cacheRead'] === 'number' &&
    typeof u['cacheWrite'] === 'number' &&
    typeof u['totalTokens'] === 'number' &&
    cost !== undefined &&
    typeof cost['input'] === 'number' &&
    typeof cost['output'] === 'number' &&
    typeof cost['cacheRead'] === 'number' &&
    typeof cost['cacheWrite'] === 'number' &&
    typeof cost['total'] === 'number'
  );
}

/**
 * Convert Pi tool execution result to the plain string expected by Makaio step events.
 *
 * Pi SDK surfaces structured tool results from `AgentToolResult.content`, which
 * is an array of `TextContent | ImageContent`. The first `TextContent` entry's
 * `text` field is used; everything else is JSON-serialized as a fallback.
 *
 * This helper is exported to make it independently testable.
 * @param rawResult - Pi SDK tool result (AgentToolResult.content or raw output)
 * @returns String form used in `tool_output` step events
 */
export function normalizeToolOutput(rawResult: unknown): string {
  if (rawResult == null) return '';

  // Pi SDK surfaces tool results as content arrays: [{ type: 'text', text: '...' }]
  if (Array.isArray(rawResult)) {
    const textEntry = rawResult.find(
      (entry): entry is { type: string; text: string } =>
        typeof entry === 'object' &&
        entry !== null &&
        (entry as Record<string, unknown>)['type'] === 'text' &&
        typeof (entry as Record<string, unknown>)['text'] === 'string',
    );
    if (textEntry) return textEntry.text;
    return JSON.stringify(rawResult);
  }

  if (typeof rawResult === 'string') return rawResult;
  return JSON.stringify(rawResult);
}

/**
 * Normalize Pi tool arguments to the record shape used by agent.tool events.
 * @param rawArgs - Raw Pi SDK tool arguments
 * @returns Record arguments when available
 */
function normalizeToolArgs(rawArgs: unknown): Record<string, unknown> | undefined {
  return typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)
    ? (rawArgs as Record<string, unknown>)
    : undefined;
}

/**
 * Normalize Pi tool result to the agent.tool.completed schema.
 * @param rawResult - Raw Pi SDK tool result
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
 * Pi SDK Agent — middle layer between `PiAdapter` and `PiConnector`.
 *
 * Subscribes to scoped PiSdkBus subjects emitted by PiConnector and
 * translates them into global `agent.*` subjects consumed by the framework.
 *
 * Pi owns its session history and compaction, so this agent returns `true`
 * from `supportsNativeResume()` — Makaio does NOT inject prior message history
 * into follow-up turns.
 */
export class PiAgent extends AIAgent<PiSdkBus, PiConnector> {
  /**
   * Wire all PiConnector events to global agent.* subjects.
   *
   * Called automatically during init() and connector swap.
   * @param connector - The PiConnector instance to wire events from
   */
  protected override wireEvents(connector: PiConnector): void {
    this.wireTurnLifecycleEvents(connector);
    this.wireMessageEvents(connector);
    this.wireToolEvents(connector);
    this.wireUsageTracking(connector);
    this.wireToolApprovalRpc(connector);
  }

  /**
   * Pi SDK owns session history and compaction, so native resume is preferred
   * over fresh-with-history on subsequent turns.
   * @returns true — Pi manages its own conversation context
   */
  protected override supportsNativeResume(): boolean {
    return true;
  }

  /**
   * Wire turn lifecycle events to global agent.* subjects.
   *
   * - `agent_started` → `emitStart()` to emit `agent.started` (orchestration contract)
   * - `agent_complete` → use the accumulated `text` field (set by the session layer)
   *   and emit `agent.message` for session persistence. The session layer accumulates
   *   assistant text from `text_end` events and injects it into `agent_complete` so the
   *   agent layer does not need to parse raw Pi SDK message arrays.
   * - `error` → stash error metadata via `emitError()` for the next `emitCompletion`
   * @param connector - The PiConnector to subscribe on
   */
  private wireTurnLifecycleEvents(connector: PiConnector): void {
    this.subscribeConnector(connector, PiSdkSubjects.agent_started, async () => {
      await this.emitStart();
    });

    this.subscribeConnector(connector, PiSdkSubjects.agent_complete, async (ctx) => {
      const text = ctx.payload.text ?? '';
      await this.emitGlobal(AgentSubjects.message, { content: text });
    });

    this.subscribeConnector(connector, PiSdkSubjects.error, async (ctx) => {
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
   * - `text_complete` → step lifecycle (started + finished) + `agent.message` for storage.
   *   Both `emitStepStarted` and `emitStepFinished` are emitted here because Pi SDK
   *   accumulates the full block in the connector before emitting `text_complete`.
   *
   * Reasoning (thinking) blocks:
   * - `thinking_delta` → `agent.reasoning_delta` for live UI streaming
   * - `thinking_complete` → step lifecycle (started + finished) + `agent.reasoning` for storage.
   * @param connector - The PiConnector to subscribe on
   */
  private wireMessageEvents(connector: PiConnector): void {
    // --- Text streaming ---
    this.subscribeConnector(connector, PiSdkSubjects.text_delta, async (ctx) => {
      await this.emitGlobal(AgentSubjects.message_delta, { text: ctx.payload.delta });
    });

    this.subscribeConnector(connector, PiSdkSubjects.text_complete, async (ctx) => {
      const { text } = ctx.payload;
      await this.emitStepStarted('text', { type: 'text' });
      await this.emitStepFinished('text', { type: 'text', content: text });
      // AgentSubjects.message is emitted once at agent_complete (turn end), not per
      // text block — aligned with qwen-acp and gemini-sdk which emit it only at turn completion.
    });

    // --- Reasoning streaming ---
    this.subscribeConnector(connector, PiSdkSubjects.thinking_delta, async (ctx) => {
      await this.emitGlobal(AgentSubjects.reasoning_delta, { content: ctx.payload.delta });
    });

    this.subscribeConnector(connector, PiSdkSubjects.thinking_complete, async (ctx) => {
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
   * @param connector - The PiConnector to subscribe on
   */
  private wireToolEvents(connector: PiConnector): void {
    this.subscribeConnector(connector, PiSdkSubjects.tool_started, async (ctx) => {
      const { toolName, toolCallId, args } = ctx.payload;
      const normalizedArgs = normalizeToolArgs(args);
      await this.emitToolUse(toolName, normalizedArgs, toolCallId);
      await this.emitGlobal(AgentSubjects.tool.started, { toolName, toolCallId });
      await this.emitStepStarted('tool_use', { type: 'tool_use', toolName, toolCallId });
    });

    this.subscribeConnector(connector, PiSdkSubjects.tool_completed, async (ctx) => {
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
   * Pi SDK reports usage via the `usage` subject after each message completes.
   * The `usage` field is typed as `unknown` in the namespace to avoid hard-coupling
   * to the Pi SDK peer type. A type-guard narrows it to `PiRawUsage` before
   * normalization; unknown shapes log a warning and are skipped.
   *
   * Normalization mapping:
   * - `input` → `inputTokens`
   * - `output` → `outputTokens`
   * - `cacheRead` → `inputCachedTokens`
   * - `cacheWrite` → `cacheWriteTokens`
   * - `totalTokens` → `totalTokens`
   * - `cost.total` → `cost` (USD)
   * - `provider` → `'pi-sdk'`
   * @param connector - The PiConnector to subscribe on
   */
  private wireUsageTracking(connector: PiConnector): void {
    this.subscribeConnector(connector, PiSdkSubjects.usage, async (ctx) => {
      const { usage } = ctx.payload;

      if (!isPiRawUsage(usage)) {
        console.warn('[PiAgent] Received usage event with unexpected shape; skipping.');
        return;
      }

      const normalized: NormalizedCallUsage = {
        provider: 'pi-sdk',
        inputTokens: usage.input,
        inputCachedTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        outputTokens: usage.output,
        reasoningTokens: 0,
        totalTokens: usage.totalTokens,
        costUnits: usage.totalTokens,
        costUnitType: 'tokens',
        cost: usage.cost.total,
      };

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
   * approval flow shared with the test harness. The lazy callback resolves
   * `adapterSessionId` at request time via `getAdapterSessionId()` to avoid
   * the race condition where the session hasn't started yet at wire time.
   *
   * `sessionId` is always set when running within a Makaio session; the assertion
   * here surfaces a configuration error early rather than producing a silent
   * approval failure.
   * @param connector - The PiConnector to wire the RPC handler on
   */
  private wireToolApprovalRpc(connector: PiConnector): void {
    this.addConnectorWiringCleanup(
      registerToolApprovalHandler(
        connector,
        async () => {
          if (this.sessionId == null) {
            throw new Error('[PiAgent] sessionId is required for tool approval');
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
