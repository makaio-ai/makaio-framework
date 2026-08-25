import {
  ProceduralAgentConnector,
  type ProceduralConnectorSession,
  type WireSessionSubjects,
  type WireSessionConfig,
  type NormalizedMessageInput,
  MessageHandle,
  type ConnectorSendMessageOptions,
  UserMessageQueue,
  type BaseAgentConnectorConfig,
  type LedgerSessionContext,
  type AIReasoningLevel,
  rejectQueuedHandles,
} from '@makaio/ai-adapters-core';
import type { ScopedBus } from '@makaio/bus-core';
import {
  McpSubjects,
  type ConnectorTeardownResult,
  type McpSessionContext,
  type ToolListItem,
} from '@makaio/contracts';

/**
 * Minimal session contract required by BaseStreamConnector.
 *
 * Extends `ProceduralConnectorSession` with the lifecycle methods that the
 * connector delegates to: reusable `abort` for interrupt, terminal `close` for
 * ownership release, and `updateModel`/`updateCwd` for in-place mutation without
 * a full session swap.
 */
export interface StreamConnectorSession extends ProceduralConnectorSession {
  /** Abort the active turn while keeping the session available for later turns. */
  abort(): Promise<void>;
  /** Terminally retire the session and prevent later queue processing. */
  close(): Promise<void>;
  /**
   * Update the model used for subsequent API calls.
   * @param model - New model identifier
   */
  updateModel(model: string): void;
  /**
   * Update the working directory used for subsequent tool executions.
   * @param cwd - New working directory path
   */
  updateCwd(cwd: string): void;
  /**
   * Update the session's tool set for the next API call.
   * Optional — not all adapters support mid-session tool updates.
   * @param tools - New tool list in generic `ToolListItem` format; session converts internally
   */
  updateTools?(tools: ToolListItem[]): void;
  /**
   * Update the reasoning effort level used for subsequent API calls.
   * Optional — only adapters that pass reasoning per-request implement this seam.
   * @param level - New reasoning effort level
   */
  updateReasoning?(level: AIReasoningLevel): void;
}

/**
 * Config shape required by `BaseStreamConnector`.
 *
 * Extends `BaseAgentConnectorConfig` and widens `mcpSessionContext` to include
 * the full {@link McpSessionContext} shape so the stream connector can
 * re-resolve the session via the bus (which requires `sessionId`, `profileId`,
 * and `projectId`). The orchestrator always supplies a full `McpSessionContext`;
 * `LedgerSessionContext` is retained in the union for standalone/test connectors
 * that do not need bus re-resolve.
 * @typeParam TBus - Scoped bus type for the adapter namespace
 * @typeParam TProviderConfig - Provider-specific config object
 */
export type BaseStreamConnectorConfig<
  TBus extends ScopedBus<string> = ScopedBus<string>,
  TProviderConfig extends object = object,
> = Omit<BaseAgentConnectorConfig<TBus, TProviderConfig>, 'mcpSessionContext'> & {
  /**
   * MCP session context resolved by the orchestrator.
   * May be the full {@link McpSessionContext} (with `sessionId`/`servers` for
   * bus re-resolve) or a bare `LedgerSessionContext` for standalone connectors.
   * The connector discriminates at runtime via `'sessionId' in ctx`.
   */
  mcpSessionContext?: McpSessionContext | LedgerSessionContext;
};

/**
 * Abstract base class for stream-based AI adapter connectors.
 *
 * Captures the shared connector lifecycle logic between the Anthropic SDK and
 * OpenAI Node adapters. Both connectors follow an identical pattern:
 *
 * - Lazy single-session initialisation via `ensureSession` / `initializeSession`
 * - Tool fetching on first turn (delegated to the abstract `fetchTools` hook)
 * - `sendMessage` → `processUserMessages` delegation to `ProceduralAgentConnector`
 * - In-place model and cwd mutation via `changeModelInPlace` / `changeCwdInPlace`
 *
 * Concrete subclasses must implement the following abstract hooks:
 * - `fetchTools()` — fetch adapter-specific tools and cache them internally
 * - `createSession()` — construct the concrete session instance
 * - `getTurnSubjects()` — return adapter-specific turn lifecycle subjects
 *
 * Subclasses may override `afterSessionCreated()` for extra post-creation wiring
 * (e.g. Anthropic sets tools on the session after construction).
 * @typeParam TBus - Scoped bus type for the adapter namespace
 * @typeParam TSession - Concrete session type; must satisfy `StreamConnectorSession`
 * @typeParam TConfig - Connector config type extending `BaseStreamConnectorConfig<TBus>`
 */
export abstract class BaseStreamConnector<
  TBus extends ScopedBus<string>,
  TSession extends StreamConnectorSession,
  TConfig extends BaseStreamConnectorConfig<TBus>,
> extends ProceduralAgentConnector<TBus, TConfig> {
  /** Session manages Turn lifecycle. Initialised lazily on first message. */
  private session?: TSession;

  /** Message queue for serialising async send operations. */
  private readonly userMessageQueue = new UserMessageQueue();

  /** MCP tools resolved for direct injection into the session. */
  protected mcpDirectTools: ToolListItem[] = [];

  /**
   * Fresh MCP session context fetched via bus during `refreshTools()`.
   *
   * When set, `prepareMcpDirectTools()` reads from this cache instead of the
   * startup snapshot in `config.mcpSessionContext`, ensuring that mid-session
   * tool refreshes reflect the current registry state rather than the state
   * at connector construction time.
   */
  private mcpSessionContextCache?: McpSessionContext;

  /**
   * Flag set via `markToolRefreshPending()` by the AIAgent layer on MCP bus events.
   * Checked at turn boundaries to trigger `refreshTools()`.
   *
   * Refreshing mid-turn would mutate the tool set while the LLM is actively
   * generating tool calls against the current set, risking inconsistent state.
   * Instead, the refresh is deferred to the next turn boundary:
   *
   * - Consumed in `onTurnStarted` (primary) so the next turn uses updated tools
   *   immediately, before the API call is made.
   * - Consumed in `onTurnFinished` (safety net) for updates that arrive
   *   mid-turn, ensuring the turn after that also picks up the updated tools.
   */
  protected hasPendingToolRefresh = false;

  /**
   * Set to `true` by `refreshTools()` when MCP direct-inject tools have been
   * re-prepared but the canonical turn number for the next turn is not yet known.
   *
   * Flushed to the tool ledger in `onTurnStarted`, after `consumeTurnNumber()`
   * has committed the real canonical value, ensuring `recordInjection` is always
   * called with the correct turn number rather than a speculative `currentTurnNumber + 1`.
   */
  private hasPendingLedgerInjection = false;

  /**
   * Marks that MCP tools have changed and should be refreshed at the next turn boundary.
   *
   * Called by the AIAgent layer when receiving MCP bus events (`mcp.tools.updated`,
   * `mcp.tools.enabled`). The connector will call `refreshTools()` before processing
   * the next queued message.
   */
  public markToolRefreshPending(): void {
    this.hasPendingToolRefresh = true;
  }

  // ---------------------------------------------------------------------------
  // Abstract hooks — each adapter must implement these
  // ---------------------------------------------------------------------------

  /**
   * Fetch adapter-specific tools from the bus and cache them internally.
   *
   * Called once before the first session is created. Implementations store
   * the result in their own typed field (e.g. `this.anthropicTools`) which is
   * then passed to `createSession()`.
   */
  protected abstract fetchTools(): Promise<void>;

  /**
   * Construct and return the concrete session instance.
   *
   * Called by `initializeSession` after tools have been fetched. The session
   * config should be fully populated from `this.config`, `this.cwd`,
   * `this.model`, and the previously fetched tools.
   * @returns The initialised adapter-specific session
   */
  protected abstract createSession(): TSession;

  /**
   * Perform any adapter-specific post-creation wiring on the session.
   *
   * Called immediately after `createSession()` and before `wireSessionEvents()`.
   * The default implementation is a no-op — override only when the adapter
   * needs extra wiring beyond what `createSession()` already handles.
   * @param _session - The freshly created session instance
   */
  protected afterSessionCreated(_session: TSession): void {
    // no-op by default
  }

  /**
   * Return the adapter's namespace-specific turn subjects for `wireSessionEvents`.
   *
   * Forwarded to `ProceduralAgentConnector.wireSessionEvents` which subscribes
   * to turn lifecycle events and updates connector processing state.
   * @returns Turn subject definitions for this adapter's namespace
   */
  protected abstract getTurnSubjects(): WireSessionSubjects<TBus['namespace']>;

  // ---------------------------------------------------------------------------
  // ProceduralAgentConnector abstract implementations
  // ---------------------------------------------------------------------------

  /**
   * Get the active session instance.
   * @returns The session or `undefined` if not yet initialised
   */
  protected getSession(): TSession | undefined {
    return this.session;
  }

  /**
   * Ensure the session is initialised and return it.
   *
   * No-op if the session already exists (idempotent). Creates and wires the
   * session on first call by delegating to `initializeSession`.
   * @returns The initialised session as `ProceduralConnectorSession`
   */
  protected async ensureSession(): Promise<ProceduralConnectorSession> {
    if (this.isTurnEventLifecycleClosed) {
      throw new Error(`[${this.config.adapterName}] Cannot initialize a closed connector`);
    }
    if (!this.session) {
      await this.initializeSession();
    }
    if (!this.session) {
      throw new Error(`[${this.config.adapterName}] Cannot initialize a closed connector`);
    }
    return this.session;
  }

  /**
   * Get the user message queue for this connector.
   * @returns The `UserMessageQueue` instance shared across all turns
   */
  protected getSessionQueue(): UserMessageQueue {
    return this.userMessageQueue;
  }

  // ---------------------------------------------------------------------------
  // Session initialisation
  // ---------------------------------------------------------------------------

  /**
   * Initialise the session for SDK lifecycle management.
   *
   * Fetches tools (once via `fetchToolsViaBus`), prepares MCP direct-inject
   * tools, constructs the concrete session via `createSession`, runs optional
   * adapter-specific post-creation wiring via `afterSessionCreated`, wires turn
   * events to the connector state machine via `wireSessionEvents`, pushes any
   * MCP direct-inject tools into the session via `updateTools`, then records
   * the initial injection set in the tool ledger at the correct turn number
   * (1 for fresh sessions; the staged canonical turn for connector swaps).
   */
  private async initializeSession(): Promise<void> {
    await this.fetchToolsViaBus();
    if (this.isTurnEventLifecycleClosed) return;
    this.prepareMcpDirectTools();

    this.session = this.createSession();
    this.afterSessionCreated(this.session);
    this.wireSessionEvents();

    // Push MCP direct-inject tools to session for the first turn.
    // Must run before recordInjection so session and ledger stay in sync.
    if (this.mcpDirectTools.length > 0) {
      this.session.updateTools?.(this.mcpDirectTools);
    }

    // Record initial injection in ledger at the correct turn number.
    // On fresh session creation both pendingCanonicalTurnNumber and
    // currentTurnNumber are unset (undefined / 0), so we fall back to 1.
    // On connector swap setCanonicalTurnNumber() has already staged a
    // pendingCanonicalTurnNumber that reflects the live session turn; use
    // that value so the ledger history is not corrupted by a false turn-1 write.
    const injectionTurn = (this.pendingTurnNumber ?? this.currentTurnNumber) || 1;
    this.config.toolLedger?.recordInjection(this.mcpDirectTools, injectionTurn);
  }

  /**
   * Convert MCP direct-inject tools from the session context to the generic
   * `ToolListItem` format and cache in `this.mcpDirectTools`.
   *
   * Called during `initializeSession()` after `fetchToolsViaBus()`, and again
   * by `refreshTools()` when the tool set may have changed. Reads from
   * `mcpSessionContextCache` when available (populated by a bus re-resolve),
   * falling back to the startup snapshot in `config.mcpSessionContext`.
   * No-op when neither source is present.
   */
  protected prepareMcpDirectTools(): void {
    const ctx = this.mcpSessionContextCache ?? this.config.mcpSessionContext;
    if (!ctx) return;
    this.mcpDirectTools = ctx.directTools.map(
      (tool): ToolListItem => ({
        name: tool.fullName,
        description: tool.description ?? '',
        toolsetName: tool.serverName,
        inputSchema: tool.inputSchema,
      }),
    );
  }

  /**
   * Fetch tools from the bus if not already loaded.
   *
   * Guards with a `this.session` check so tools are only fetched once per
   * connector lifetime. Delegates to the abstract `fetchTools` hook which each
   * adapter implements to populate its own typed tools field.
   */
  protected async fetchToolsViaBus(): Promise<void> {
    if (this.session) return;
    await this.fetchTools();
  }

  /**
   * Re-prepare MCP direct-inject tools for the next turn.
   *
   * Called at turn boundary when `hasPendingToolRefresh` is true (set via
   * `markToolRefreshPending()`). When a full `McpSessionContext` (with
   * `sessionId`) is available, issues a `McpSubjects['session.resolve']` bus
   * call to fetch the latest tool state from the registry, updating
   * `mcpSessionContextCache` so `prepareMcpDirectTools()` reads fresh data.
   * If the bus call fails, logs a warning and falls back to the previous cache
   * (or the startup snapshot) so the connector remains operational.
   *
   * Subclasses that manage native adapter-format tools (e.g. Anthropic, OpenAI)
   * override this to: (1) re-fetch their native tools, (2) call
   * `super.refreshTools()` to re-prepare `mcpDirectTools` and arm the ledger
   * flag, then (3) push the updated tool list to the active session via
   * `this.getSession()?.updateTools?.(this.mcpDirectTools)`.
   *
   * Unlike `fetchTools()` which runs once before session creation,
   * `refreshTools()` operates on a live session and may be called multiple
   * times during a connector's lifetime.
   */
  protected async refreshTools(): Promise<void> {
    await this.resolveAndCacheMcpContext();
    this.prepareMcpDirectTools();
    this.hasPendingLedgerInjection = true;
  }

  /**
   * Re-resolve the MCP session context from the bus and update the cache.
   *
   * Only fires when the startup config holds a full `McpSessionContext` (i.e.
   * it has a `sessionId`). Standalone connectors created without a session skip
   * this and continue to use the existing cache or startup snapshot.
   * On bus failure the warning is logged and the cache is left unchanged so
   * the connector can continue with the last known good tool set.
   */
  private async resolveAndCacheMcpContext(): Promise<void> {
    const ctx = this.config.mcpSessionContext;
    if (!ctx || !('sessionId' in ctx)) return;

    try {
      this.mcpSessionContextCache = await this.globalBus.request(McpSubjects.session.resolve, {
        sessionId: ctx.sessionId,
        profileId: ctx.profileId,
        projectId: ctx.projectId,
      });
    } catch (error) {
      console.warn(`[${this.config.adapterName}] MCP session re-resolve failed; using previous tool snapshot.`, error);
    }
  }

  /**
   * Wire turn-boundary hooks into the session lifecycle.
   *
   * - `onTurnStarted`: commit the canonical turn number via `consumeTurnNumber`,
   *   refresh tools if a pending update arrived while idle or during the previous
   *   turn (primary refresh path), then flush any pending ledger injection so
   *   `recordInjection` is always called with the real turn number. The order
   *   matters: consumeTurnNumber → refreshTools → recordInjection, because
   *   `refreshTools` sets `hasPendingLedgerInjection`.
   * - `onTurnFinished`: safety-net refresh for updates that arrive mid-turn,
   *   before draining the queue so the following turn uses the updated tool set.
   * @returns Wire session configuration with the turn hooks
   */
  protected override getWireSessionConfig(): WireSessionConfig {
    return {
      onTurnStarted: async () => {
        this.consumeTurnNumber();
        // Refresh tools before the API call if an MCP update arrived while idle
        // or during the previous turn. This ensures the LLM sees the latest
        // tool set. The onTurnFinished path remains as a safety net for
        // updates that arrive mid-turn.
        if (this.hasPendingToolRefresh) {
          try {
            await this.refreshTools();
          } catch (error) {
            console.warn(
              `[${this.config.adapterName}] Tool refresh failed at turn start; continuing with stale tools.`,
              error,
            );
          } finally {
            this.hasPendingToolRefresh = false;
          }
        }
        if (this.hasPendingLedgerInjection) {
          this.config.toolLedger?.recordInjection(this.mcpDirectTools, this.currentTurnNumber);
          this.hasPendingLedgerInjection = false;
        }
      },
      onTurnFinished: async (drainQueue) => {
        if (this.hasPendingToolRefresh) {
          try {
            await this.refreshTools();
          } catch (error) {
            console.warn(`[${this.config.adapterName}] Tool refresh failed; continuing with stale tools.`, error);
          } finally {
            this.hasPendingToolRefresh = false;
          }
        }
        await drainQueue();
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Shared method implementations
  // ---------------------------------------------------------------------------

  /**
   * Resolve the runtime system prompt to a plain string for the SDK API.
   *
   * - `string` mode: use as-is
   * - Append mode: use `content` directly (stream-based adapters have no base
   *   prompt to append to)
   * @returns Resolved prompt string, or `undefined` if no prompt is set
   */
  protected resolveSystemPrompt(): string | undefined {
    if (this.systemPrompt === undefined) return undefined;
    return typeof this.systemPrompt === 'string' ? this.systemPrompt : this.systemPrompt.content;
  }

  /**
   * Send a message to the agent.
   * @param message - The normalised message to send
   * @param options - Optional send message options
   * @returns A handle for tracking the message
   */
  public async sendMessage(
    message: NormalizedMessageInput,
    options?: ConnectorSendMessageOptions,
  ): Promise<MessageHandle> {
    const handle = this.createMessageHandle(message, options);
    await this.processUserMessages([handle]);
    return handle;
  }

  /**
   * Abort the agent and clean up resources.
   *
   * Note: Session-closed event emission is handled by the adapter's AIAgent
   * layer, not by the connector.
   */
  public abort(): void {
    void this.session?.abort();
  }

  /**
   * Gracefully close the session and report what was observed.
   *
   * **Class: `detached`.** The local evidence stops at the abort. Closing a
   * stream connector aborts its session, which *pauses* the active turn and
   * signals an `AbortController`; nothing awaits the settlement of the HTTP
   * request that signal is meant to end, and the provider request may still be
   * in flight when this resolves. There is no process to watch and no
   * acknowledged connection shutdown, so `released` would claim that no callback
   * can arrive afterwards — which is precisely what is not established here.
   * @returns `detached`, naming the settlement this close does not wait for.
   */
  public async close(): Promise<ConnectorTeardownResult> {
    // A closed connector must stop receiving turn events, whatever class it
    // reports: a live subscription keeps it reachable from the bus, and a later
    // generation on this agent id would drive its state machine. `detached` is a
    // weaker claim about the *provider*, not a licence to stay wired locally.
    const turnEventDrain = this.closeTurnEventLifecycle();
    // The connector owns this queue, so terminal close must settle accepted
    // handles when it removes the turn-finished handler that normally drains it.
    rejectQueuedHandles(this.userMessageQueue);
    const session = this.session;
    this.session = undefined;
    // `close()` synchronously closes the session's dispatch gate before awaiting
    // the active turn pause. Start it before any close-time drain can yield so a
    // retained session reference cannot dispatch after terminal close begins.
    const closeSession = session?.close();
    await turnEventDrain;
    await closeSession;
    return {
      evidence: 'detached',
      detail: 'The stream session was aborted; the provider request settlement is not awaited here.',
    };
  }

  /**
   * Perform an in-place model update without swapping the connector.
   *
   * Stream-based adapters are stateless — the session caches `config.model` at
   * construction but must be synced here so the next turn uses the new model.
   *
   * **Mutation contract:** Implementations MUST NOT mutate `this.model`.
   * The caller owns the connector-level `model` field update after this returns.
   * @param newModel - The model identifier to switch to
   * @returns Always `true` — stateless APIs never require a full connector swap
   */
  public override async changeModelInPlace(newModel: string): Promise<boolean> {
    this.session?.updateModel(newModel);
    return true;
  }

  /**
   * Perform an in-place working-directory update without swapping the connector.
   *
   * Stream-based adapters are stateless — cwd is only used for tool execution
   * context, not for persistent session state.
   *
   * **Mutation contract:** Implementations MUST NOT mutate `this.cwd`.
   * The caller owns the connector-level `cwd` field update after this returns.
   * @param newCwd - The working directory path to switch to
   * @returns Always `true` — stateless APIs never require a full connector swap
   */
  public override async changeCwdInPlace(newCwd: string): Promise<boolean> {
    this.session?.updateCwd(newCwd);
    return true;
  }

  /**
   * Perform an in-place reasoning effort update without swapping the connector.
   *
   * Stream-based adapters pass `reasoning_effort` (or equivalent) per-request.
   * The session's `currentReasoningEffort` field is updated so the next API
   * call uses the new level without requiring a full connector swap.
   *
   * **Mutation contract:** Implementations MUST NOT mutate `this.currentReasoningEffort`.
   * The caller owns the connector-level field update after this returns `true`.
   * @param newLevel - The new reasoning effort level to apply
   * @returns Always `true` — stateless APIs never require a full connector swap
   */
  public override async changeReasoningInPlace(newLevel: AIReasoningLevel): Promise<boolean> {
    this.session?.updateReasoning?.(newLevel);
    return true;
  }

  /**
   * Interrupt the current turn by aborting the active API request.
   */
  public async interrupt(): Promise<void> {
    await this.session?.abort();
  }

  /**
   * Get the adapter session ID.
   *
   * Stream-based adapters use a locally-generated UUID (stateless APIs provide
   * no server-side session identity).
   * @returns The local session UUID
   */
  public async getAdapterSessionId(): Promise<string> {
    if (!this.adapterSessionId) {
      this.initAdapterSessionId();
    }

    if (!this.adapterSessionId) {
      throw new Error(
        'Adapter session ID is missing in getAdapterSessionId(); ensure initAdapterSessionId() ran during connector initialization.',
      );
    }

    return this.adapterSessionId;
  }

  // ---------------------------------------------------------------------------
  // Constructor helper
  // ---------------------------------------------------------------------------

  /**
   * Initialise `adapterSessionId` from config or generate a fresh UUID.
   *
   * Call this at the end of each concrete constructor after `super()`. The
   * nullish-assignment guard ensures the swap case (where the base constructor
   * already populated `adapterSessionId` from config) is preserved.
   */
  protected initAdapterSessionId(): void {
    this.adapterSessionId ??= crypto.randomUUID();
  }
}
