import { AIAgent } from '@makaio/ai-adapters-core';
import type {
  AIAgentConnector,
  NormalizedCallUsage,
  ToolStartedEvent,
  ToolCompletedEvent,
  AgentStartedEvent,
  AgentCompleteEvent,
} from '@makaio/ai-adapters-core';
import type { ScopedBus } from '@makaio/bus-core';
import type { EventMessagePayload } from '@makaio/core';
import { AgentSubjects } from '@makaio/contracts';
import type { SessionMessageBlock, StepType, BlockData } from '@makaio/contracts';
import type { ReasoningDeltaEvent, MessageCompleteEvent, ToolCall } from '../namespaces/schemas/index.js';

/**
 * Extract the bus namespace from a connector via the same conditional type used by
 * `AIAgent.subscribeConnector` and `AIAgent.createConnectorEventMapping`.
 *
 * Using the identical conditional type expression ensures TypeScript resolves the
 * constraint at call sites without a namespace mismatch error.
 * @typeParam TConnector - Connector type extending `AIAgentConnector<ScopedBus<string>>`
 */
type ConnectorNamespace<TConnector extends AIAgentConnector<ScopedBus<string>>> =
  TConnector extends AIAgentConnector<infer TBus> ? TBus['namespace'] : never;

type ToolCallArgs = Record<string, unknown>;

/**
 * A manually typed subject definition for event (non-request) subjects.
 *
 * Uses a structural interface rather than `SubjectDefinition<SubjectRecord, ...>` to
 * avoid the incompatibility that arises when the full namespace `SubjectRecord` contains
 * a mix of event and request subjects (e.g., `tool_approval` is a request). By defining
 * only the `$meta` fields we care about, concrete subjects that extend `ScopedSubjectDefinition`
 * are still assignable here as long as they carry event payloads.
 *
 * `HandlerForSubjectDefinition<EventSubjectDef<N>>` resolves to
 * `EventHandler<Record<string, unknown>>` — a concrete, non-`never` handler type —
 * enabling the base class wire methods to use typed handler parameters.
 * @typeParam TNamespace - The adapter bus namespace string
 */
type EventSubjectDef<TNamespace extends string> = {
  readonly $meta: {
    readonly payload: EventMessagePayload<Record<string, unknown>>;
    readonly namespace: TNamespace;
    readonly isRequest: false;
    readonly local: boolean;
    readonly channel: boolean;
  };
  readonly subject: string;
};

/**
 * Adapter-specific subjects for stream-based agent wiring.
 *
 * Groups all connector scoped subjects used during event wiring into a single spec
 * type parameter. Subjects whose payloads differ between adapters (chunk, usage,
 * toolCalls, reasoningComplete) carry a generic `EventSubjectDef`. Concrete adapters
 * supply fully typed subjects when implementing `getConnectorSubjects()` — the typed
 * subjects extend `EventSubjectDef` so TypeScript can resolve handler signatures.
 * @typeParam TNamespace - The adapter bus namespace string literal
 */
export interface StreamAdapterSubjectSpec<TNamespace extends string> {
  /**
   * Streaming chunk subject. Payload differs per adapter:
   * - Anthropic: `{ eventType, index, delta }` (delta.text for text_delta)
   * - OpenAI: `{ eventType, id, choices }` (choices[0].delta.content)
   */
  readonly chunk: EventSubjectDef<TNamespace>;
  /**
   * Token usage subject. Payload differs per adapter:
   * - Anthropic: has `cache_read_input_tokens` / `cache_creation_input_tokens`
   * - OpenAI: has `prompt_tokens_details` / `completion_tokens_details`
   */
  readonly usage: EventSubjectDef<TNamespace>;
  /**
   * Tool calls subject. Payload differs per adapter:
   * - Anthropic: each tool call entry carries a provider `blockIndex`
   * - OpenAI: base ToolCall without blockIndex
   */
  readonly toolCalls: EventSubjectDef<TNamespace>;
  /**
   * Reasoning complete subject. Payload differs per adapter:
   * - Anthropic: base + `signature` field (for native history round-trip)
   * - OpenAI: base only
   */
  readonly reasoningComplete: EventSubjectDef<TNamespace>;
  /** Assembled message complete event — `content` field is shared across adapters. */
  readonly messageComplete: EventSubjectDef<TNamespace>;
  /** Incremental reasoning content delta — payload is shared across adapters. */
  readonly reasoningDelta: EventSubjectDef<TNamespace>;
  /** Tool execution started lifecycle event — payload is shared across adapters. */
  readonly toolStarted: EventSubjectDef<TNamespace>;
  /** Tool execution completed lifecycle event — payload is shared across adapters. */
  readonly toolCompleted: EventSubjectDef<TNamespace>;
  /** Agent turn started lifecycle event — payload is shared across adapters. */
  readonly agentStarted: EventSubjectDef<TNamespace>;
  /** Agent turn completed lifecycle event — payload is shared across adapters. */
  readonly agentComplete: EventSubjectDef<TNamespace>;
}

/**
 * Parse tool-call args and keep only plain-object payloads.
 * @param rawArgs - Serialized JSON arguments
 * @returns Parsed object args or empty object when input is invalid/non-object
 */
function parseToolArgs(rawArgs: string): ToolCallArgs {
  try {
    const parsed = JSON.parse(rawArgs);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Abstract base class for stream-based AI adapter agents.
 *
 * Captures the shared event-wiring logic between the Anthropic SDK and
 * OpenAI Node agent implementations. Both agents follow an identical two-tier
 * fan-out pattern:
 *
 * 1. `wireSdkEvents()` routes the sdk.event catch-all to typed semantic subjects
 * (adapter-specific — kept abstract to avoid complex generics with `createConnectorEventMapping`).
 * 2. `wireSemanticEvents()` wires semantic subjects to global `agent.*` subjects
 * (shared — implemented here; delegates adapter-specific parts to abstract hooks).
 *
 * Abstract hooks that subclasses must implement:
 * - `wireSdkEvents()` — routes sdk.event to semantic subjects (adapter-specific).
 * - `getConnectorSubjects()` — returns the semantic subject spec for this adapter.
 * - `extractChunkText(payload)` — extracts text from adapter-specific chunk events.
 * - `extractUsagePayload(payload)` — maps adapter-specific usage to `NormalizedCallUsage`.
 * - `emitUsageContextWindowUpdate(payload)` — emits context window status after usage tracking.
 * - `reserveToolCallBlockIndex(tc)` — assigns block index for a tool call.
 * - `afterToolCallStepEmitted(blockIndex)` — post-emission book-keeping for tool_calls.
 * - `getFallbackToolCompletedBlockIndex()` — fallback index when map lookup misses.
 * - `afterToolCompletedStepEmitted(resolvedBlockIndex)` — post-emission book-keeping for tool_completed.
 * - `buildReasoningBlock(payload)` — constructs the reasoning `SessionMessageBlock`.
 * - `wireToolApprovalRpc(connector)` — wires the adapter's tool_approval RPC to the global bus.
 * @typeParam TBus - Scoped bus for the adapter namespace
 * @typeParam TConnector - Concrete connector type extending `AIAgentConnector<TBus>`
 * @typeParam TSpec - Subject spec whose namespace matches `ConnectorNamespace<TConnector>`
 */
export abstract class BaseStreamAgent<
  TBus extends ScopedBus<string>,
  TConnector extends AIAgentConnector<TBus>,
  TSpec extends StreamAdapterSubjectSpec<ConnectorNamespace<TConnector>>,
> extends AIAgent<TBus, TConnector> {
  /**
   * Track toolCallId → blockIndex for correlation between step.started and step.finished.
   *
   * Both adapters emit parallel tool calls (all at once in the tool_calls event),
   * but results arrive asynchronously in separate tool_completed events, potentially
   * out of order. This map ensures each tool's step.finished uses the same blockIndex
   * as its step.started, maintaining correlation regardless of arrival order.
   *
   * Pattern:
   * 1. tool_calls event: reserve blockIndex per toolCallId, store in map
   * 2. tool_completed event: lookup stored blockIndex, emit step.finished, delete from map
   */
  protected toolBlockIndexMap = new Map<string, number>();
  /**
   * Track tool call IDs whose completion already arrived.
   *
   * Some providers can deliver `tool_completed` before `tool_calls` under
   * race conditions. Mark completed IDs so late `tool_calls` can be ignored
   * instead of emitting out-of-order step.started/tool.use events.
   */
  protected completedToolIds = new Set<string>();
  /**
   * Stash tool call args keyed by toolCallId.
   *
   * Args are available when `tool_calls` fires (parsed from function arguments)
   * but must be forwarded to `tool_completed` which arrives separately.
   * Entries are removed after emission to prevent unbounded growth.
   */
  protected toolCallArgsMap = new Map<string, ToolCallArgs>();

  private resetPerTurnToolTracking(): void {
    this.toolBlockIndexMap.clear();
    this.completedToolIds.clear();
    this.toolCallArgsMap.clear();
  }

  // ---------------------------------------------------------------------------
  // Abstract hooks — each adapter must implement these
  // ---------------------------------------------------------------------------

  /**
   * Tier 1: Route sdk.event catch-all to typed semantic subjects.
   *
   * Implement by calling `this.createConnectorEventMapping(connectorSubjects.sdk.event, 'eventType', { ... }, 'event')`
   * using the adapter's own typed connector subjects. This is kept adapter-specific to avoid
   * complex generic type constraints when calling `createConnectorEventMapping` from a generic context.
   */
  protected abstract wireSdkEvents(): void;

  /**
   * Return the semantic subject spec for this adapter's connector namespace.
   *
   * Called once during `wireEvents()`. The returned subjects are used to subscribe
   * to connector events and emit to global `agent.*` subjects.
   * @returns Subject spec for this adapter's connector namespace
   */
  protected abstract getConnectorSubjects(): TSpec;

  /**
   * Extract plain text from an adapter-specific chunk event payload.
   *
   * - Anthropic: checks `delta.type === 'text_delta'` and returns `delta.text`
   * - OpenAI: returns `choices[0]?.delta?.content ?? ''`
   * @param payload - Raw chunk event payload (cast from the connector's chunk event type)
   * @returns Plain text string, or empty string when the chunk carries no text content
   */
  protected abstract extractChunkText(payload: Record<string, unknown>): string;

  /**
   * Map an adapter-specific usage event payload to the shared `NormalizedCallUsage` format.
   *
   * - Anthropic: reads `cache_read_input_tokens`, `cache_creation_input_tokens`
   * - OpenAI: reads `prompt_tokens_details.cached_tokens`, `completion_tokens_details.reasoning_tokens`
   *
   * Implementations must declare the truthful `granularity` of their usage
   * signal (see `docs/architecture/adapters/usage-and-provenance.md`). It is
   * intentionally not hard-coded here: both current subclasses report
   * `provider-call` (one usage event per provider request), but the base class
   * makes no such guarantee for future stream adapters.
   * @param payload - Raw usage event payload (cast from the connector's usage event type)
   * @returns Normalized usage metrics ready for `trackUsage()`
   */
  protected abstract extractUsagePayload(payload: Record<string, unknown>): NormalizedCallUsage;

  /**
   * Emit the context window update after processing a usage event.
   *
   * Adapters differ in which fields provide the cached token count and the default
   * max context window size. Called from `wireUsageEvents` after `trackUsage()`.
   * @param payload - Raw usage event payload (same object passed to `extractUsagePayload`)
   */
  protected abstract emitUsageContextWindowUpdate(payload: Record<string, unknown>): Promise<void>;

  /**
   * Reserve a block index for a tool call from the tool_calls event.
   *
   * - Anthropic: returns `(tc as AnthropicToolCall).blockIndex` (provider-native; no counter mutation).
   * - OpenAI: returns `this.getBlockIndex()` and increments the internal counter.
   *
   * Called once per tool call in `wireToolEvents` before emitting step.started.
   * @param tc - The tool call entry from the tool_calls event payload
   * @returns The block index to use for this tool call's step.started / step.finished pair
   */
  protected abstract reserveToolCallBlockIndex(tc: ToolCall): number;

  /**
   * Perform adapter-specific book-keeping after a tool call's step.started has been emitted.
   *
   * - Anthropic: calls `reconcileInternalBlockIndex(blockIndex)` to keep the internal
   *   block index counter in sync with provider-native indices.
   * - OpenAI: no-op (the counter was already incremented inside `reserveToolCallBlockIndex`).
   * @param blockIndex - The block index that was just emitted for this tool call
   */
  protected abstract afterToolCallStepEmitted(blockIndex: number): void;

  /**
   * Return the fallback block index when `toolBlockIndexMap` has no entry for a toolCallId.
   *
   * Used only when a tool_completed event arrives without a matching tool_calls entry
   * (out-of-order delivery or state mismatch).
   *
   * - Anthropic: `this.getBlockIndex()` (also increments the internal counter for monotonicity)
   * - OpenAI: `-1` (sentinel indicating unknown index)
   * @returns Fallback block index for unresolvable toolCallId map lookups
   */
  protected abstract getFallbackToolCompletedBlockIndex(): number;

  /**
   * Perform adapter-specific book-keeping after a tool_completed step.finished has been emitted.
   *
   * - Anthropic: calls `reconcileInternalBlockIndex(resolvedBlockIndex)`.
   * - OpenAI: no-op.
   * @param resolvedBlockIndex - The block index used for this tool's step.finished
   */
  protected abstract afterToolCompletedStepEmitted(resolvedBlockIndex: number): void;

  /**
   * Build the `SessionMessageBlock` for a reasoning step from the reasoning_complete payload.
   *
   * - Anthropic: `{ type: 'reasoning', content, metadata: { signature } }` when `signature` is set
   * - OpenAI: `{ type: 'reasoning', content }` (no metadata)
   * @param payload - Raw reasoning complete event payload (cast from the connector's event type)
   * @returns A reasoning block suitable for `emitStepFinished`
   */
  protected abstract buildReasoningBlock(payload: Record<string, unknown>): SessionMessageBlock;

  /**
   * Register the tool approval RPC handler for this adapter's connector.
   *
   * Wires the adapter-scoped `tool_approval` subject to the global
   * `AgentSubjects.toolApprove` via the adapter-specific `registerToolApprovalHandler`
   * factory (generated by `createToolApprovalHandler`). Called during `wireEvents()`.
   * @param connector - The adapter connector to register the tool approval handler on
   */
  protected abstract wireToolApprovalRpc(connector: TConnector): void;

  // ---------------------------------------------------------------------------
  // Shared wiring implementation — identical across all stream-based adapters
  // ---------------------------------------------------------------------------

  /**
   * Wire connector events to global agent.* subjects.
   *
   * Entry point called by `AIAgent.init()` after connector creation.
   * Follows a two-tier fan-out pattern:
   * 1. `wireSdkEvents()` — abstract, routes sdk.event to typed semantic subjects.
   * 2. `wireSemanticEvents()` — shared, wires semantic subjects to global agent.* subjects.
   * @param connector - The adapter connector to wire events from
   */
  protected wireEvents(connector: TConnector): void {
    // Tier 1: Route sdk.event catch-all → semantic subjects (adapter-specific)
    this.wireSdkEvents();

    // Tier 2: Wire semantic subjects → global agent.* subjects (shared)
    this.wireSemanticEvents(connector, this.getConnectorSubjects());

    // Wire tool approval RPC: forward tool_approval to global AgentSubjects.toolApprove
    this.wireToolApprovalRpc(connector);
  }

  /**
   * Wire semantic subjects to global agent.* subjects.
   *
   * Delegates to individual wire methods grouped by event category.
   * @param connector - The adapter connector to subscribe on
   * @param subjects - The adapter's connector subjects from `getConnectorSubjects()`
   */
  private wireSemanticEvents(connector: TConnector, subjects: TSpec): void {
    this.wireMessageEvents(connector, subjects);
    this.wireUsageEvents(connector, subjects);
    this.wireToolEvents(connector, subjects);
    this.wireReasoningEvents(connector, subjects);
    this.wireLifecycleEvents(connector, subjects);
  }

  /**
   * Wire message streaming and completion events.
   *
   * - `chunk` → `agent.message_delta` (adapter-specific text via `extractChunkText`)
   * - `message_complete` → `agent.message` + step.started/step.finished for text content
   * @param connector - The adapter connector to subscribe on
   * @param subjects - The adapter's connector subjects
   */
  private wireMessageEvents(connector: TConnector, subjects: TSpec): void {
    // chunk -> agent.message_delta (adapter-specific text extraction)
    this.subscribeConnector(connector, subjects.chunk, async (ctx) => {
      const text = this.extractChunkText(ctx.payload);
      if (text) {
        await this.emitGlobal(AgentSubjects.message_delta, { text });
      }
    });

    // message_complete -> agent.message + step events
    this.subscribeConnector(connector, subjects.messageComplete, async (ctx) => {
      const { content } = ctx.payload as MessageCompleteEvent;

      // Emit step.started and step.finished for text content blocks
      if (content) {
        await this.emitStepStarted('text');
        await this.emitStepFinished('text', { type: 'text', content });
      }

      await this.emitGlobal(AgentSubjects.message, { content: content ?? '' });
    });
  }

  /**
   * Wire token usage tracking events.
   *
   * Delegates payload parsing to `extractUsagePayload` and context window emission
   * to `emitUsageContextWindowUpdate` (both adapter-specific).
   * @param connector - The adapter connector to subscribe on
   * @param subjects - The adapter's connector subjects
   */
  private wireUsageEvents(connector: TConnector, subjects: TSpec): void {
    this.subscribeConnector(connector, subjects.usage, async (ctx) => {
      const normalized = this.extractUsagePayload(ctx.payload);
      await this.trackUsage(normalized);
      await this.emitUsageContextWindowUpdate(ctx.payload);
    });
  }

  /**
   * Wire tool lifecycle events (tool_calls, tool_started, tool_completed).
   *
   * - `tool_calls` → per-tool `agent.step.started` + `agent.tool.use`
   * - `tool_started` → `agent.tool.started`
   * - `tool_completed` → `agent.step.finished` + `agent.tool.completed`
   * @param connector - The adapter connector to subscribe on
   * @param subjects - The adapter's connector subjects
   */
  private wireToolEvents(connector: TConnector, subjects: TSpec): void {
    // tool_calls -> agent.tool.use (for each) + step.started
    this.subscribeConnector(connector, subjects.toolCalls, async (ctx) => {
      const { toolCalls } = ctx.payload as { toolCalls: ToolCall[] };

      for (const tc of toolCalls) {
        if (this.completedToolIds.has(tc.id)) {
          console.warn(`[BaseStreamAgent] Ignoring late tool_calls for completed toolCallId ${tc.id}`);
          continue;
        }

        const args = parseToolArgs(tc.function.arguments);
        this.toolCallArgsMap.set(tc.id, args);

        const blockIndex = this.reserveToolCallBlockIndex(tc);
        this.toolBlockIndexMap.set(tc.id, blockIndex);

        await this.emitGlobal(AgentSubjects.step.started, {
          stepType: 'tool_use' as StepType,
          blockIndex,
          blockData: {
            type: 'tool_use',
            toolName: tc.function.name,
            toolCallId: tc.id,
          } satisfies BlockData,
          content: {
            type: 'tool_call',
            toolCallId: tc.id,
            name: tc.function.name,
            args,
          },
        });

        this.afterToolCallStepEmitted(blockIndex);

        await this.emitGlobal(AgentSubjects.tool.use, {
          toolName: tc.function.name,
          args,
          toolCallId: tc.id,
        });
      }
    });

    // tool_started -> agent.tool.started
    this.subscribeConnector(connector, subjects.toolStarted, async (ctx) => {
      const { toolName, toolCallId } = ctx.payload as ToolStartedEvent;
      await this.emitGlobal(AgentSubjects.tool.started, { toolName, toolCallId });
    });

    // tool_completed -> agent.tool.completed + step.finished
    this.subscribeConnector(connector, subjects.toolCompleted, async (ctx) => {
      const { toolCallId, toolName, result, success } = ctx.payload as ToolCompletedEvent;
      this.completedToolIds.add(toolCallId);

      const storedBlockIndex = this.toolBlockIndexMap.get(toolCallId);
      if (storedBlockIndex === undefined) {
        console.warn(`[BaseStreamAgent] toolCallId ${toolCallId} missing from toolBlockIndexMap; using fallback`);
      }
      const resolvedBlockIndex = storedBlockIndex ?? this.getFallbackToolCompletedBlockIndex();
      this.toolBlockIndexMap.delete(toolCallId);

      await this.emitGlobal(AgentSubjects.step.finished, {
        stepType: 'tool_use' as StepType,
        blockIndex: resolvedBlockIndex,
        content: {
          type: 'tool_output',
          toolCallId,
          output: result,
          isError: !success,
        },
      });

      this.afterToolCompletedStepEmitted(resolvedBlockIndex);

      const args = this.toolCallArgsMap.get(toolCallId);
      this.toolCallArgsMap.delete(toolCallId);
      if (args === undefined) {
        console.warn(`[BaseStreamAgent] toolCallId ${toolCallId} missing args for tool ${toolName}`);
      }

      await this.emitGlobal(AgentSubjects.tool.completed, {
        toolName,
        args,
        result: { output: result },
        success,
        toolCallId,
      });
    });
  }

  /**
   * Wire reasoning streaming and completion events.
   *
   * - `reasoning_delta` → `agent.reasoning_delta`
   * - `reasoning_complete` → `agent.reasoning` + step.started/step.finished
   * @param connector - The adapter connector to subscribe on
   * @param subjects - The adapter's connector subjects
   */
  private wireReasoningEvents(connector: TConnector, subjects: TSpec): void {
    // reasoning_delta -> agent.reasoning_delta
    this.subscribeConnector(connector, subjects.reasoningDelta, async (ctx) => {
      const { content } = ctx.payload as ReasoningDeltaEvent;
      await this.emitGlobal(AgentSubjects.reasoning_delta, { content });
    });

    // reasoning_complete -> agent.reasoning + step events
    this.subscribeConnector(connector, subjects.reasoningComplete, async (ctx) => {
      const content = (ctx.payload as { content: string }).content;

      if (content) {
        const reasoningBlock = this.buildReasoningBlock(ctx.payload);
        await this.emitStepStarted('reasoning');
        await this.emitStepFinished('reasoning', reasoningBlock);
      }

      await this.emitGlobal(AgentSubjects.reasoning, { content: content ?? '' });
    });
  }

  /**
   * Wire agent lifecycle events.
   *
   * - `agent_started` → clears per-turn tool tracking and calls `emitStart()`
   * - `agent_complete` → clears per-turn tool tracking
   * Note: `agent_complete` emission is handled by `AIAgent` via `onMessageHandle()`
   * when the connector calls `markCompleted()`. We subscribe only for state reset.
   * @param connector - The adapter connector to subscribe on
   * @param subjects - The adapter's connector subjects
   */
  private wireLifecycleEvents(connector: TConnector, subjects: TSpec): void {
    // agent_started -> reset per-turn state and emitStart()
    this.subscribeConnector(connector, subjects.agentStarted, async (ctx) => {
      const _agentStarted = ctx.payload as AgentStartedEvent;
      this.resetPerTurnToolTracking();
      await this.emitStart();
    });

    // agent_complete -> clear per-turn state
    this.subscribeConnector(connector, subjects.agentComplete, async (ctx) => {
      const _agentComplete = ctx.payload as AgentCompleteEvent;
      this.resetPerTurnToolTracking();
    });
  }
}
