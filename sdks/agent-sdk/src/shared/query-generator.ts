import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects, type AIReasoningLevel } from '@makaio/contracts';
import type { EventHandler } from '@makaio/core';
import { createAccumulatorState, mapBusEventToSdkMessage } from './messages.js';
import type { AccumulatorState } from './messages.js';
import type { ResolvedQueryConfig } from './options.js';
import { MakaioUnsupportedFeatureError } from './errors.js';
import type {
  AccountInfo,
  McpServerConfig,
  McpSetServersResult,
  McpServerStatus,
  MakaioQuery,
  ModelInfo,
  SDKMessage,
  SlashCommand,
} from './types.js';
import {
  accountInfo as queryAccountInfo,
  mcpServerStatus as queryMcpServerStatus,
  supportedCommands as querySupportedCommands,
  supportedModels as querySupportedModels,
} from './introspection.js';

// ---------------------------------------------------------------------------
// Internal queue types
// ---------------------------------------------------------------------------

/** Deferred resolution/rejection pair for a pending next() call. */
interface PendingPull {
  resolve: (result: IteratorResult<SDKMessage, void>) => void;
  reject: (error: unknown) => void;
}

// ---------------------------------------------------------------------------
// Push-pull queue
// ---------------------------------------------------------------------------

/**
 * State for the push-pull message queue that bridges bus events to the generator.
 * The queue holds only `SDKMessage` values — the done signal is handled in-band
 * by `cleanup()` and never placed in the array.
 *
 * `pendingPull` is a FIFO array: multiple concurrent `next()` calls each park a
 * deferred entry here; `pushMessage` shifts the oldest waiter first.
 */
interface QueueState {
  readonly queue: SDKMessage[];
  readonly pendingPull: PendingPull[];
  closed: boolean;
}

/**
 * Create a fresh queue state object.
 * @returns Mutable queue state.
 */
const createQueueState = (): QueueState => ({
  queue: [],
  pendingPull: [],
  closed: false,
});

/**
 * Enqueue an SDK message or deliver it to the oldest parked pull immediately.
 * When multiple `next()` calls are in flight, the FIFO `pendingPull` array
 * ensures the earliest waiter is satisfied first.
 * @param qs - Mutable queue state.
 * @param msg - Message to deliver.
 */
const pushMessage = (qs: QueueState, msg: SDKMessage): void => {
  if (qs.closed) return;
  const oldest = qs.pendingPull.shift();
  if (oldest !== undefined) {
    oldest.resolve({ value: msg, done: false });
  } else {
    qs.queue.push(msg);
  }
};

interface AgentIdentity {
  readonly agentId: string;
  readonly adapterId: string;
  readonly adapterName: string;
  readonly adapterSessionId: string;
}

type QueryProtocol = Pick<
  MakaioQuery,
  'next' | 'return' | 'throw' | typeof Symbol.asyncIterator | typeof Symbol.asyncDispose
>;

type SetMcpServersHandler = (
  identity: AgentIdentity,
  servers: Record<string, McpServerConfig>,
) => Promise<McpSetServersResult>;

type AgentStreamSubject =
  | typeof AgentSubjects.started
  | typeof AgentSubjects.message_delta
  | typeof AgentSubjects.reasoning_delta
  | typeof AgentSubjects.message
  | typeof AgentSubjects.reasoning
  | typeof AgentSubjects.tool.use
  | typeof AgentSubjects.tool.output
  | typeof AgentSubjects.tool.completed
  | typeof AgentSubjects.step.started
  | typeof AgentSubjects.step.finished
  | typeof AgentSubjects.complete
  | typeof AgentSubjects.contextWindow.updated
  | typeof AgentSubjects.usage;

const hasNonEmptyText = (value: string): boolean => value.trim().length > 0;

/**
 * Subscribe a subject-agnostic stream handler to an agent event subject.
 *
 * Query streaming maps many `agent.*` event subjects through the same
 * `mapBusEventToSdkMessage()` seam. These handlers only require a record-like
 * payload and never write subject-specific results, so centralizing the
 * generic bus cast keeps that invariant in one place.
 * @param bus - Bus instance to subscribe on.
 * @param subject - Agent stream event subject.
 * @param handler - Subject-agnostic event handler.
 * @param filter - Session filter for the subscription.
 * @returns Cleanup function that removes the subscription.
 */
const subscribeAgentStreamSubject = <Subject extends AgentStreamSubject>(
  bus: IMakaioBus,
  subject: Subject,
  handler: EventHandler<Record<string, unknown>>,
  filter: { sessionId: string },
): (() => void) => bus.on(subject as never, handler as never, { filter });

/**
 * Return the started agent identity or reject a control call with its phase-specific message.
 * @param getAgentIdentity - Returns the currently known agent identity.
 * @param message - Error message to use when the agent has not started.
 * @returns Started agent identity.
 */
const requireAgentIdentity = (getAgentIdentity: () => AgentIdentity | null, message: string): AgentIdentity => {
  const identity = getAgentIdentity();
  if (identity === null) {
    throw new Error(message);
  }
  return identity;
};

const mapThinkingTokensToReasoningEffort = (tokens: number | null): AIReasoningLevel => {
  if (tokens === null || tokens <= 0) return 'none';
  if (!Number.isFinite(tokens)) {
    throw new TypeError('maxThinkingTokens must be a finite number or null');
  }
  if (tokens <= 4_000) return 'low';
  if (tokens <= 8_000) return 'medium';
  if (tokens <= 16_000) return 'high';
  return 'extra-high';
};

// ---------------------------------------------------------------------------
// Bus subscription helpers
// ---------------------------------------------------------------------------

/**
 * Register all agent event subscriptions on the bus and return an array of
 * unsubscribe functions.
 * @param bus - Bus instance to subscribe on.
 * @param sessionId - Session ID used as payload filter.
 * @param state - Mutable accumulator for message mapping.
 * @param qs - Mutable queue state receiving mapped messages.
 * @param onAgentStarted - Callback invoked once the agent.started event fires,
 *   providing the actual agentId from the event payload.
 * @param onAgentComplete - Callback invoked after an agent.complete result is queued.
 * @returns Array of unsubscribe callbacks.
 */
const subscribeAgentEvents = (
  bus: IMakaioBus,
  sessionId: string,
  state: AccumulatorState,
  qs: QueueState,
  onAgentStarted: (identity: AgentIdentity) => void,
  onAgentComplete: () => void,
): Array<() => void> => {
  const filter = { sessionId };

  const makeHandler =
    (subject: string): EventHandler<Record<string, unknown>> =>
    (ctx) => {
      const msg = mapBusEventToSdkMessage(subject, ctx.payload, state);
      if (msg !== null) pushMessage(qs, msg);
    };

  const onStarted: EventHandler<Record<string, unknown>> = (ctx) => {
    onAgentStarted({
      agentId: String(ctx.payload.agentId ?? ''),
      adapterId: String(ctx.payload.adapterId ?? ''),
      adapterName: String(ctx.payload.adapterName ?? ''),
      adapterSessionId: String(ctx.payload.adapterSessionId ?? ''),
    });
    const msg = mapBusEventToSdkMessage('agent.started', ctx.payload, state);
    if (msg !== null) pushMessage(qs, msg);
  };

  const onComplete: EventHandler<Record<string, unknown>> = (ctx) => {
    const msg = mapBusEventToSdkMessage('agent.complete', ctx.payload, state);
    if (msg !== null) pushMessage(qs, msg);
    onAgentComplete();
  };

  return [
    subscribeAgentStreamSubject(bus, AgentSubjects.started, onStarted, filter),
    subscribeAgentStreamSubject(bus, AgentSubjects.message_delta, makeHandler('agent.message_delta'), filter),
    subscribeAgentStreamSubject(bus, AgentSubjects.reasoning_delta, makeHandler('agent.reasoning_delta'), filter),
    subscribeAgentStreamSubject(bus, AgentSubjects.message, makeHandler('agent.message'), filter),
    subscribeAgentStreamSubject(bus, AgentSubjects.reasoning, makeHandler('agent.reasoning'), filter),
    subscribeAgentStreamSubject(bus, AgentSubjects.tool.use, makeHandler('agent.tool.use'), filter),
    subscribeAgentStreamSubject(bus, AgentSubjects.tool.output, makeHandler('agent.tool.output'), filter),
    subscribeAgentStreamSubject(bus, AgentSubjects.tool.completed, makeHandler('agent.tool.completed'), filter),
    subscribeAgentStreamSubject(bus, AgentSubjects.step.started, makeHandler('agent.step.started'), filter),
    subscribeAgentStreamSubject(bus, AgentSubjects.step.finished, makeHandler('agent.step.finished'), filter),
    subscribeAgentStreamSubject(bus, AgentSubjects.complete, onComplete, filter),
    subscribeAgentStreamSubject(
      bus,
      AgentSubjects.contextWindow.updated,
      makeHandler('agent.contextWindow.updated'),
      filter,
    ),
    subscribeAgentStreamSubject(bus, AgentSubjects.usage, makeHandler('agent.usage'), filter),
  ];
};

// ---------------------------------------------------------------------------
// Capability methods — independent of per-query state, extracted to keep the
// factory function focused on event wiring.
// ---------------------------------------------------------------------------

/**
 * Build capability methods for a query.
 * @param bus - Bus instance used for introspection RPCs.
 * @param config - Resolved query config used to derive the provider name.
 * @param sessionId - Query session ID used for session-scoped lookups.
 * @param getAgentIdentity - Returns the started agent identity when available.
 * @returns Partial MakaioQuery covering discovery methods.
 */
const buildCapabilityMethods = (
  bus: IMakaioBus,
  config: ResolvedQueryConfig,
  sessionId: string,
  getAgentIdentity: () => AgentIdentity | null,
): Pick<MakaioQuery, 'supportedModels' | 'supportedCommands' | 'mcpServerStatus' | 'accountInfo'> => ({
  /** @returns Model list from the SDK introspection seam. */
  supportedModels: (): Promise<ModelInfo[]> => querySupportedModels(bus),
  /** @returns Slash commands from the SDK introspection seam. */
  supportedCommands: (): Promise<SlashCommand[]> => Promise.resolve(querySupportedCommands()),
  /** @returns MCP server status for this query session. */
  mcpServerStatus: (): Promise<McpServerStatus[]> => queryMcpServerStatus(bus, sessionId),
  /** @returns Account info object with the provider name. */
  accountInfo: (): Promise<AccountInfo> =>
    queryAccountInfo(
      bus,
      getAgentIdentity()?.adapterName ??
        (config.parsedModel.kind === 'qualified' ? config.parsedModel.segment1 : undefined),
    ),
});

const buildQueryProtocol = (qs: QueueState, cleanup: () => void): QueryProtocol => ({
  next: (): Promise<IteratorResult<SDKMessage, void>> => {
    if (qs.queue.length > 0) {
      return Promise.resolve({ value: qs.queue.shift()!, done: false });
    }
    if (qs.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise<IteratorResult<SDKMessage, void>>((resolve, reject) => {
      qs.pendingPull.push({ resolve, reject });
    });
  },
  return: (_value?: void): Promise<IteratorResult<SDKMessage, void>> => {
    cleanup();
    return Promise.resolve({ value: undefined, done: true });
  },
  throw: (error?: unknown): Promise<IteratorResult<SDKMessage, void>> => {
    cleanup();
    // Match AsyncIterator throw() semantics: a supplied error rejects the
    // throw() call, while an omitted value is treated as graceful termination.
    return error !== undefined ? Promise.reject(error) : Promise.resolve({ value: undefined, done: true });
  },
  [Symbol.asyncIterator]() {
    return this;
  },
  [Symbol.asyncDispose](): Promise<void> {
    cleanup();
    return Promise.resolve();
  },
});

const buildControlMethods = (
  bus: IMakaioBus,
  getAgentIdentity: () => AgentIdentity | null,
  onSetMcpServers?: SetMcpServersHandler,
): Pick<MakaioQuery, 'interrupt' | 'setModel' | 'setMaxThinkingTokens' | 'setMcpServers'> => ({
  interrupt: async (): Promise<void> => {
    const identity = requireAgentIdentity(getAgentIdentity, 'Cannot interrupt before agent has started');
    const result = await bus.request(AgentSubjects.interrupt, {
      agentId: identity.agentId,
      adapterId: identity.adapterId,
      adapterName: identity.adapterName,
      adapterSessionId: identity.adapterSessionId,
    });
    if (!result.success) {
      throw new Error(`Failed to interrupt query: ${result.reason ?? 'unknown error'}`);
    }
  },
  setModel: async (model?: string): Promise<void> => {
    const identity = requireAgentIdentity(getAgentIdentity, 'Cannot change model before agent has started');
    const result = await bus.request(AgentSubjects.model.change, {
      agentId: identity.agentId,
      adapterId: identity.adapterId,
      adapterName: identity.adapterName,
      adapterSessionId: identity.adapterSessionId,
      newModel: model,
      skipWarning: true,
      turnActiveBehavior: 'stageForNextTurn',
    });
    if (!result.success) {
      throw new Error(`Failed to change model: ${result.reason ?? 'unknown error'}`);
    }
  },
  setMaxThinkingTokens: async (tokens: number | null): Promise<void> => {
    const identity = requireAgentIdentity(
      getAgentIdentity,
      'Cannot change max thinking tokens before agent has started',
    );
    const result = await bus.request(AgentSubjects.model.change, {
      agentId: identity.agentId,
      adapterId: identity.adapterId,
      adapterName: identity.adapterName,
      adapterSessionId: identity.adapterSessionId,
      reasoningEffort: mapThinkingTokensToReasoningEffort(tokens),
      skipWarning: true,
      turnActiveBehavior: 'stageForNextTurn',
    });
    if (!result.success) {
      throw new Error(`Failed to change max thinking tokens: ${result.reason ?? 'unknown error'}`);
    }
  },
  setMcpServers: async (servers: Record<string, McpServerConfig>): Promise<McpSetServersResult> => {
    const identity = requireAgentIdentity(getAgentIdentity, 'Cannot change MCP servers before agent has started');
    if (onSetMcpServers === undefined) {
      throw new MakaioUnsupportedFeatureError('setMcpServers()', 'no in-flight MCP reconfiguration handler is wired');
    }
    return onSetMcpServers(identity, servers);
  },
});

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Parameters for createQueryGenerator. */
export interface CreateQueryGeneratorParams {
  /** Bus instance (local MakaioBus or remote scoped bus from /core transport). */
  bus: IMakaioBus;
  /** Makaio session ID used to filter bus events to this query's session. */
  sessionId: string;
  /**
   * Initial agent ID hint for control operations (interrupt, model change).
   * The real agentId is captured from the `agent.started` event and overwrites
   * this value; `setModel()` rejects until then.
   */
  agentId: string;
  /** Resolved query config produced by normalizeOptions(). */
  config: ResolvedQueryConfig;
  /**
   * Optional callback invoked at the start of `cleanup()`, before bus handlers
   * are unsubscribed. Use this to deregister external subscriptions (e.g.,
   * `canUseTool` unsub, `agentId` sub unsub) without monkey-patching `close()`.
   */
  onClose?: () => void;
  /** Called after each agent.complete result has been queued. */
  onTurnComplete?: () => void;
  /** Handler for dynamic MCP server replacement. */
  onSetMcpServers?: SetMcpServersHandler;
  /**
   * Return true when an agent.complete event should finish the generator.
   * Multi-turn prompt dispatchers keep the generator open between turns.
   */
  shouldCloseOnComplete?: () => boolean;
}

/**
 * Create a push-based AsyncGenerator that subscribes to `agent.*` bus events
 * filtered by sessionId, maps them to SDK messages via the message mapper, and
 * yields them in arrival order.
 *
 * Bus event handlers push messages onto an internal queue; the generator's
 * `next()` drains the queue on each pull. When `agent.complete` fires the
 * generator yields the result message and then marks itself done.
 * @param params - Bus instance, session/agent identifiers, and resolved config.
 * @returns A {@link MakaioQuery} that implements the full control interface.
 */
export function createQueryGenerator(params: CreateQueryGeneratorParams): MakaioQuery {
  const { bus, sessionId, config, onClose, onTurnComplete } = params;

  // The real agentId is resolved when agent.started fires. Until then,
  // setModel() rejects to prevent issuing requests against an unknown agent.
  let resolvedAgentIdentity: AgentIdentity | null = null;
  let cleanedUp = false;

  const onAgentStarted = (identity: AgentIdentity): void => {
    resolvedAgentIdentity = {
      ...identity,
      agentId: hasNonEmptyText(identity.agentId) ? identity.agentId : params.agentId,
    };
  };

  const state = createAccumulatorState();
  const qs = createQueueState();
  const unsubscribers: Array<() => void> = [];
  const unsubscribeAll = (): void => {
    for (const unsub of unsubscribers) unsub();
  };
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    qs.closed = true;
    onClose?.();
    unsubscribeAll();
    for (const { resolve } of qs.pendingPull.splice(0)) {
      resolve({ value: undefined, done: true });
    }
  };
  const onAgentComplete = (): void => {
    onTurnComplete?.();
    if (params.shouldCloseOnComplete?.() ?? true) cleanup();
  };
  unsubscribers.push(...subscribeAgentEvents(bus, sessionId, state, qs, onAgentStarted, onAgentComplete));

  // --------------------------------------------------------------------------
  // Assemble the MakaioQuery object
  // --------------------------------------------------------------------------

  return {
    ...buildQueryProtocol(qs, cleanup),
    ...buildControlMethods(bus, () => resolvedAgentIdentity, params.onSetMcpServers),
    ...buildCapabilityMethods(bus, config, sessionId, () => resolvedAgentIdentity),
    close: cleanup,
  };
}

/**
 * Return a MakaioQuery facade immediately while asynchronous connection and
 * session startup continue in the background.
 * @param queryPromise - Promise resolving to the real query generator.
 * @returns Synchronous MakaioQuery-compatible facade.
 */
export function deferQuery(queryPromise: Promise<MakaioQuery>): MakaioQuery {
  let closed = false;
  let query: MakaioQuery | null = null;
  const ready = queryPromise.then((resolved) => {
    query = resolved;
    if (closed) resolved.close();
    return resolved;
  });
  void ready.catch(() => undefined);

  const getQuery = async (): Promise<MakaioQuery> => ready;
  const done = (): IteratorResult<SDKMessage, void> => ({ value: undefined, done: true });

  return {
    async next() {
      if (closed && query === null) return done();
      return (await getQuery()).next();
    },
    async return(value?: void) {
      closed = true;
      if (query === null) return done();
      return query.return(value);
    },
    async throw(error?: unknown) {
      closed = true;
      if (query === null) {
        return error !== undefined ? Promise.reject(error) : done();
      }
      return query.throw(error);
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    [Symbol.asyncDispose](): Promise<void> {
      this.close();
      return Promise.resolve();
    },
    interrupt: async () => (await getQuery()).interrupt(),
    setModel: async (model?: string) => (await getQuery()).setModel(model),
    setMaxThinkingTokens: async (tokens: number | null) => (await getQuery()).setMaxThinkingTokens(tokens),
    setMcpServers: async (servers: Record<string, McpServerConfig>) => (await getQuery()).setMcpServers(servers),
    supportedModels: async () => (await getQuery()).supportedModels(),
    supportedCommands: async () => (await getQuery()).supportedCommands(),
    mcpServerStatus: async () => (await getQuery()).mcpServerStatus(),
    accountInfo: async () => (await getQuery()).accountInfo(),
    close() {
      closed = true;
      query?.close();
    },
  };
}
