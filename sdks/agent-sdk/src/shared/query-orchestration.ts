/**
 * Shared query-orchestration logic used by both the /runtime and /core entry
 * points.
 *
 * Both entry points resolve a bus instance and then delegate to
 * {@link buildQuery} here, keeping per-entry-point files thin.
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { AgentSubjects, SessionSubjects } from '@makaio/contracts';
import type { HandlerForSubjectDefinition } from '@makaio/core';
import { createQueryGenerator } from './query-generator.js';
import { registerToolApprovalHandler } from './permissions.js';
import { buildMcpSessionContext, prepareMcpServersForSession } from './mcp.js';
import type { ResolvedQueryConfig } from './options.js';
import { registerSdkToolBridge } from './tool-bridge.js';
import type { MakaioQuery, McpServerConfig, McpSetServersResult, QueryParams, SDKUserMessage } from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Subscribe to `agent.started` for the given session and invoke a callback
 * with the first `agentId` seen.  Automatically unsubscribes after first
 * delivery so it does not accumulate across multi-turn sessions.
 * @param bus - The Makaio bus instance.
 * @param sessionId - Session ID filter for the subscription.
 * @param onAgentId - Callback invoked once with the first agentId.
 * @returns Unsubscribe function (no-op after first delivery).
 */
const subscribeAgentIdOnce = (
  bus: IMakaioBus,
  sessionId: string,
  onAgentId: (agentId: string) => void,
): (() => void) => {
  let unsubscribe: (() => void) | null = null;
  const handler: HandlerForSubjectDefinition<typeof AgentSubjects.started> = (ctx): void => {
    const { agentId } = ctx.payload;
    if (agentId.trim().length === 0) return;
    unsubscribe?.();
    unsubscribe = null;
    onAgentId(agentId);
  };
  unsubscribe = bus.on(AgentSubjects.started, handler, { filter: { sessionId } });
  return () => {
    unsubscribe?.();
    unsubscribe = null;
  };
};

/**
 * Extract text from a Claude-compatible user message.
 * @param msg - SDK user message.
 * @returns Plain text content to send to the session orchestrator.
 */
const getMessageText = (msg: SDKUserMessage): string => {
  const { content } = msg.message;
  if (typeof content === 'string') return content;
  const textBlock = content.find((b) => b.type === 'text' && typeof b.text === 'string');
  return textBlock?.text ?? '';
};

interface ResolvedPrompt {
  readonly message: string;
  readonly iterator?: AsyncIterator<SDKUserMessage>;
}

interface TurnCompletionSignal {
  readonly waitForTurnComplete: () => Promise<void>;
  readonly resolveTurnComplete: () => void;
}

type PreparedMcpServers = Awaited<ReturnType<typeof prepareMcpServersForSession>>;

interface AgentIdentityForMcpReplacement {
  readonly agentId: string;
  readonly adapterId: string;
  readonly adapterName: string;
  readonly adapterSessionId: string;
}

interface McpServerReplacementController {
  readonly getPreparedServers: () => PreparedMcpServers | undefined;
  readonly close: () => void;
  readonly drainDeferred: () => void;
  readonly setMcpServers: (
    identity: AgentIdentityForMcpReplacement,
    servers: Record<string, McpServerConfig>,
  ) => Promise<McpSetServersResult>;
}

/**
 * Extract the first message string from a QueryParams prompt without closing
 * async iterables, so follow-up messages remain available for multi-turn mode.
 * @param params - Query parameters.
 * @returns Initial message and optional retained async iterator.
 */
const resolvePrompt = async (params: QueryParams): Promise<ResolvedPrompt> => {
  const { prompt } = params;
  if (typeof prompt === 'string') return { message: prompt };

  const iterator = prompt[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done === true) return { message: '' };
  return { message: getMessageText(first.value), iterator };
};

const waitForTurnCompleteFactory = (): TurnCompletionSignal => {
  const resolvers: Array<() => void> = [];
  return {
    waitForTurnComplete: () =>
      new Promise((resolve) => {
        resolvers.push(resolve);
      }),
    resolveTurnComplete: () => {
      resolvers.shift()?.();
    },
  };
};

const buildAgentPayload = (
  config: ResolvedQueryConfig,
  sessionId: string,
  mcpSessionServers?: Parameters<typeof buildMcpSessionContext>[0],
) => ({
  kind: 'canonical-model' as const,
  model: config.rawModel,
  ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
  ...(config.systemPrompt !== undefined ? { systemPrompt: config.systemPrompt } : {}),
  ...(config.allowedTools !== undefined ? { allowedTools: config.allowedTools } : {}),
  ...(config.disallowedTools !== undefined ? { disallowedTools: config.disallowedTools } : {}),
  ...(config.effort !== undefined ? { reasoningEffort: config.effort } : {}),
  ...(config.env !== undefined ? { env: config.env } : {}),
  ...(mcpSessionServers !== undefined
    ? {
        mcpSessionContext: {
          sessionId,
          servers: buildMcpSessionContext(mcpSessionServers),
          directTools: [],
          discoverableTools: [],
        },
      }
    : {}),
});

/**
 * Build the full MCP session context used by the agent runtime mutation subject.
 * @param sessionId - Query session identifier.
 * @param servers - Transport-only MCP server record.
 * @returns Replacement MCP session context with direct server exposure.
 */
const toMcpSessionContext = (sessionId: string, servers: Parameters<typeof buildMcpSessionContext>[0]) => ({
  sessionId,
  servers: buildMcpSessionContext(servers),
  directTools: [],
  discoverableTools: [],
});

/**
 * Compute user-facing server-name changes for setMcpServers().
 * @param previousServers - Previously active prepared server record.
 * @param nextServers - Replacement prepared server record.
 * @returns Added and removed server names.
 */
const diffServerNames = (
  previousServers: Record<string, unknown> | undefined,
  nextServers: Record<string, unknown>,
): Pick<McpSetServersResult, 'added' | 'removed'> => {
  const previous = new Set(Object.keys(previousServers ?? {}));
  const next = new Set(Object.keys(nextServers));

  return {
    added: [...next].filter((name) => !previous.has(name)),
    removed: [...previous].filter((name) => !next.has(name)),
  };
};

const dispatchMessage = async (
  bus: IMakaioBus,
  sessionId: string,
  message: string,
  agentPayload?: ReturnType<typeof buildAgentPayload>,
  responseSchema?: Record<string, unknown>,
): Promise<void> => {
  await bus.request(SessionSubjects.sendMessage, {
    sessionId,
    message,
    ...(agentPayload !== undefined ? { agent: agentPayload } : {}),
    ...(responseSchema !== undefined ? { responseSchema } : {}),
    source: 'user' as const,
  });
};

const runFollowUpDispatcher = async (
  bus: IMakaioBus,
  sessionId: string,
  iterator: AsyncIterator<SDKUserMessage>,
  waitForTurnComplete: () => Promise<void>,
  onComplete: () => void,
  maxTurns?: number,
): Promise<void> => {
  let completedTurns = 0;
  while (true) {
    await waitForTurnComplete();
    completedTurns += 1;
    if (maxTurns !== undefined && completedTurns >= maxTurns) {
      onComplete();
      return;
    }
    const next = await iterator.next();
    if (next.done === true) {
      onComplete();
      return;
    }
    await dispatchMessage(bus, sessionId, getMessageText(next.value));
  }
};

const startFollowUpDispatcher = (
  bus: IMakaioBus,
  sessionId: string,
  iterator: AsyncIterator<SDKUserMessage> | undefined,
  waitForTurnComplete: () => Promise<void>,
  maxTurns: number | undefined,
  onExhausted: () => void,
): void => {
  if (iterator === undefined) return;
  void runFollowUpDispatcher(bus, sessionId, iterator, waitForTurnComplete, onExhausted, maxTurns).catch(onExhausted);
};

/**
 * Wire an AbortController into the query lifecycle.
 * @param bus - Bus instance used to emit session closure.
 * @param sessionId - Query session ID to close.
 * @param generator - Query generator to terminate locally.
 * @param abortController - Optional caller-provided abort controller.
 * @param cleanups - Cleanup stack that removes abort listeners on query close.
 */
const registerAbortController = (
  bus: IMakaioBus,
  sessionId: string,
  generator: MakaioQuery,
  abortController: AbortController | undefined,
  cleanups: Array<() => void>,
): void => {
  if (abortController === undefined) return;
  const { signal } = abortController;
  const abortQuery = (): void => {
    void bus.emit(SessionSubjects.closed, { sessionId, reason: 'aborted' });
    generator.close();
  };
  if (signal.aborted) {
    abortQuery();
    return;
  }
  signal.addEventListener('abort', abortQuery, { once: true });
  cleanups.push(() => signal.removeEventListener('abort', abortQuery));
};

/**
 * Own SDK MCP bridge lifetime for initial and dynamic query server sets.
 * @param bus - Bus instance used to request agent runtime mutation.
 * @param sessionId - Query session identifier.
 * @param initialPreparedServers - Initial prepared server set, if configured.
 * @returns Controller for replacement, cleanup, and prepared-server access.
 */
const createMcpServerReplacementController = (
  bus: IMakaioBus,
  sessionId: string,
  initialPreparedServers: PreparedMcpServers | undefined,
): McpServerReplacementController => {
  let preparedMcpServers = initialPreparedServers;
  const deferredMcpServerCleanups: PreparedMcpServers[] = [];
  const closePreparedMcpServers = (prepared: PreparedMcpServers, label: string): void => {
    void prepared.close().catch((error: unknown) => {
      console.error(`[Agent SDK] Failed to close ${label} SDK MCP server bridge:`, error);
    });
  };
  const drainDeferred = (): void => {
    for (const prepared of deferredMcpServerCleanups.splice(0)) {
      closePreparedMcpServers(prepared, 'replaced');
    }
  };

  return {
    getPreparedServers: () => preparedMcpServers,
    close: () => {
      drainDeferred();
      if (preparedMcpServers !== undefined) closePreparedMcpServers(preparedMcpServers, 'active');
    },
    drainDeferred,
    setMcpServers: async (identity, servers) => {
      const nextPrepared = await prepareMcpServersForSession(servers);
      const previousPrepared = preparedMcpServers;
      try {
        const result = await bus.request(AgentSubjects.mcp.servers.set, {
          agentId: identity.agentId,
          adapterId: identity.adapterId,
          adapterName: identity.adapterName,
          adapterSessionId: identity.adapterSessionId,
          mcpSessionContext: toMcpSessionContext(sessionId, nextPrepared.servers),
          turnActiveBehavior: 'stageForNextTurn',
        });
        if (!result.success) {
          throw new Error(`Failed to change MCP servers: ${result.reason ?? 'unknown error'}`);
        }
        preparedMcpServers = nextPrepared;
        if (previousPrepared !== undefined) {
          if (result.staged === true) {
            deferredMcpServerCleanups.push(previousPrepared);
          } else {
            closePreparedMcpServers(previousPrepared, 'replaced');
          }
        }
        return { ...diffServerNames(previousPrepared?.servers, nextPrepared.servers), errors: {} };
      } catch (error) {
        await nextPrepared.close().catch((closeError: unknown) => {
          console.error('[Agent SDK] Failed to close rejected SDK MCP server bridge:', closeError);
        });
        throw error;
      }
    },
  };
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build and start a query against a connected bus instance.
 *
 * Handles session ID generation, optional tool-approval subscription, generator
 * creation, and the initial `session.sendMessage` dispatch.  External cleanup
 * callbacks (e.g. tool-approval unsubscribes) are passed via the `onClose`
 * param of {@link createQueryGenerator} so they fire at generator teardown
 * without monkey-patching `close()`.
 * @param bus - Connected bus instance (local or remote).
 * @param params - Query parameters (prompt + options).
 * @param config - Resolved (normalised) query config.
 * @returns A {@link MakaioQuery} async generator.
 */
export async function buildQuery(
  bus: IMakaioBus,
  params: QueryParams,
  config: ResolvedQueryConfig,
): Promise<MakaioQuery> {
  const sessionId = config.sessionId ?? crypto.randomUUID();

  // Accumulate cleanup callbacks — all fired together via onClose when the
  // generator terminates.
  const cleanups: Array<() => void> = [];
  const { message, iterator } = await resolvePrompt(params);
  let promptExhausted = iterator === undefined;
  const { waitForTurnComplete, resolveTurnComplete } = waitForTurnCompleteFactory();

  // Subscribe to bus events BEFORE sending the message so no events are lost.
  // When canUseTool is provided, wait for the first agent.started to get the
  // agentId and then register the tool-approval handler.
  if (config.canUseTool !== undefined) {
    const canUseTool = config.canUseTool;
    const unsubStarted = subscribeAgentIdOnce(bus, sessionId, (agentId) => {
      const unsubApproval = registerToolApprovalHandler(bus, agentId, canUseTool);
      cleanups.push(unsubApproval);
    });
    cleanups.push(unsubStarted);
  }
  if (config.tools.length > 0) {
    cleanups.push(
      registerSdkToolBridge({
        bus,
        sessionId,
        cwd: config.cwd,
        env: config.env,
        tools: config.tools,
      }),
    );
  }
  const initialPreparedMcpServers =
    config.mcpServers !== undefined ? await prepareMcpServersForSession(config.mcpServers) : undefined;
  const mcpServerReplacement = createMcpServerReplacementController(bus, sessionId, initialPreparedMcpServers);
  cleanups.push(mcpServerReplacement.close);

  // Create the generator with an onClose hook that fires accumulated cleanups.
  // Bus subscriptions for agent events are live as soon as the generator is
  // created, so no events are lost between creation and sendMessage dispatch.
  // The agentId placeholder is empty — setModel() rejects until agent.started
  // fires and the generator resolves the real agentId internally.
  const generator = createQueryGenerator({
    bus,
    sessionId,
    agentId: '',
    config,
    onTurnComplete: () => {
      mcpServerReplacement.drainDeferred();
      resolveTurnComplete();
    },
    shouldCloseOnComplete: () => promptExhausted,
    onSetMcpServers: mcpServerReplacement.setMcpServers,
    onClose: () => {
      for (const cleanup of cleanups) cleanup();
    },
  });

  registerAbortController(bus, sessionId, generator, config.abortController, cleanups);

  // Build the agent configuration payload.
  const agentPayload = buildAgentPayload(config, sessionId, mcpServerReplacement.getPreparedServers()?.servers);

  // Send the message to start the agent. On failure, close the generator so
  // its onClose callback fires (unsubscribes canUseTool listeners) before rethrowing.
  try {
    if (config.abortController?.signal.aborted) {
      throw new Error('Query aborted before dispatch');
    }
    await dispatchMessage(bus, sessionId, message, agentPayload, config.outputFormat?.schema);
  } catch (err) {
    generator.close();
    throw err;
  }

  startFollowUpDispatcher(bus, sessionId, iterator, waitForTurnComplete, config.maxTurns, () => {
    promptExhausted = true;
    generator.close();
  });

  return generator;
}
