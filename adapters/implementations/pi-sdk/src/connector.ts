// NOTE: do NOT change without explicit human approval
/* eslint max-lines: ["error", { "max": 540 }] */
import {
  ProceduralAgentConnector,
  UserMessageQueue,
  type NormalizedMessageInput,
  type AgentStartResult,
  type ConnectorSendMessageOptions,
  type ConnectorStartOptions,
  type MessageHandle,
  type ProceduralConnectorSession,
  type WireSessionSubjects,
} from '@makaio/ai-adapters-core';
import { resolveConnectorCredentials } from '@makaio/ai-adapters-core/config';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@mariozechner/pi-coding-agent';
import type { Model } from '@mariozechner/pi-ai';
import type { AIReasoningLevel, SystemPrompt } from '@makaio/contracts';
import type { PiSdkBus } from './namespaces/index.js';
import { PiSdkSubjects } from './namespaces/index.js';
import { PiConnectorSession } from './session.js';
import type { PiConnectorConfig, PiThinkingLevel } from './types/index.js';
import { PiSdkAdapterName } from './constants.js';
import { fetchToolsForPi, type PiToolHandlerContext } from './tool-conversion.js';
import { registerMakaioProviderModel, REASONING_TO_THINKING } from './provider-registry.js';

/**
 * Pi SDK Connector — wraps `createAgentSession()` + `session.prompt()`.
 *
 * This is the lowest layer in the three-layer adapter architecture:
 * PiAdapter (AIAdapter) → PiAgent (AIAgent) → PiConnector (AIAgentConnector)
 *
 * Pi SDK manages its own agentic loop: `session.prompt()` is a single async
 * call that runs the full turn (including all tool round-trips) before resolving.
 * This makes it procedural rather than streaming, hence the
 * `ProceduralAgentConnector` base class.
 *
 * Key behaviors:
 * - Lazy session initialization on first `start()` or `sendMessage()` call
 * - Tool approval bridged through Pi's `agent.beforeToolCall` hook
 * - Model switching via `session.setModel()` (returns `true` from `changeModelInPlace`)
 * - CWD is bound at session creation; `changeCwdInPlace` always returns `false`
 */
export class PiConnector extends ProceduralAgentConnector<PiSdkBus, PiConnectorConfig> {
  /** Connector session instance, created lazily on first use. */
  private session?: PiConnectorSession;

  /** In-flight init promise — coalesces concurrent callers; cleared on failure for retry. */
  private sessionInitPromise?: Promise<void>;

  /** Message queue for delivery mode handling. */
  private readonly sessionMessageQueue = new UserMessageQueue();

  /** Whether a tool refresh should be triggered at the start of the next turn. */
  private toolRefreshPending = false;

  /** Terminal lifecycle guard set after close(). */
  private closed = false;

  /**
   * Create a new PiConnector instance.
   * @param config - Fully-resolved connector configuration
   */
  public constructor(config: PiConnectorConfig) {
    super({
      ...config,
      adapterId: config.adapterId ?? crypto.randomUUID(),
      adapterName: PiSdkAdapterName,
    });
  }

  // ---------------------------------------------------------------------------
  // ProceduralAgentConnector abstract implementations
  // ---------------------------------------------------------------------------

  /**
   * Get the current session instance.
   * @returns The session or undefined if not yet initialized
   */
  protected getSession(): ProceduralConnectorSession | undefined {
    return this.session;
  }

  /**
   * Initialize and return the session (single-flight; idempotent).
   *
   * Coalesces concurrent callers via `sessionInitPromise`. Cleared on failure
   * so callers can retry after a transient error.
   * @returns The initialized session
   */
  protected async ensureSession(): Promise<ProceduralConnectorSession> {
    if (this.closed) {
      throw new Error('[PiConnector] Cannot initialize a closed connector');
    }
    if (this.session) return this.session;
    if (!this.sessionInitPromise) {
      this.sessionInitPromise = this.initializeSession().catch((err: unknown) => {
        this.sessionInitPromise = undefined;
        throw err;
      });
    }
    await this.sessionInitPromise;
    if (this.closed) {
      throw new Error('[PiConnector] Cannot use a closed connector');
    }
    return this.session!;
  }

  /**
   * Get the message queue for this connector.
   * @returns The session message queue
   */
  protected getSessionQueue(): UserMessageQueue {
    return this.sessionMessageQueue;
  }

  /**
   * Get namespace turn subjects for wireSessionEvents.
   * @returns Turn subject definitions for the Pi SDK namespace
   */
  protected getTurnSubjects(): WireSessionSubjects<PiSdkBus['namespace']> {
    return PiSdkSubjects.turn;
  }

  /**
   * Get wire session configuration.
   *
   * Injects `onTurnStarted` to:
   * 1. Consume the next turn number for ledger bookkeeping
   * 2. Refresh registry tools if a refresh is pending
   * @returns Wire session configuration with turn start hooks
   */
  protected override getWireSessionConfig() {
    return {
      onTurnStarted: async () => {
        this.consumeTurnNumber();
        if (this.toolRefreshPending) {
          this.toolRefreshPending = false;
          await this.refreshRegistryTools();
        }
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Session initialization
  // ---------------------------------------------------------------------------

  /**
   * Initialize the Pi SDK session.
   *
   * Builds the model registry, constructs the resource loader and Pi session,
   * then wires turn lifecycle events. Called once via `ensureSession()`.
   */
  private async initializeSession(): Promise<void> {
    const { authStorage, modelRegistry } = await this.buildModelRegistry(this.model);

    const sessionManager = SessionManager.inMemory();
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });

    const agentDir = getAgentDir();
    const cwd = this.cwd;
    const systemPrompt = this.systemPrompt;
    const systemPromptOptions = this.resolveSystemPromptOptions(systemPrompt);

    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      // Makaio owns skill injection (via turnContext), context files, and
      // extension loading. Disable Pi's own discovery to avoid conflicts.
      noSkills: true,
      noContextFiles: true,
      noExtensions: true,
      noPromptTemplates: true,
      ...systemPromptOptions,
    });

    // Run independent I/O operations in parallel to reduce initialization latency.
    const [, piModel, customTools] = await Promise.all([
      resourceLoader.reload(),
      this.resolvePiModel(modelRegistry),
      fetchToolsForPi(this.adapterId, this.adapterName, this.toolContext),
    ]);
    const piConnectorConfig = this.config.providerConfig;

    this.session = new PiConnectorSession({
      bus: this.config.bus,
      adapterId: this.adapterId,
      adapterName: this.adapterName,
      agentId: this.agentId,
      cwd,
      model: this.model,
      env: this.config.env ?? {},
      systemPrompt,
      initialCustomToolNames: customTools.map((t) => t.name),
      requestToolApproval: (payload) => this.requestToolApproval(PiSdkSubjects.tool_approval, payload),
      onTurnStart: (handle) => {
        this.pendingMessageHandle = handle;
      },
      onTurnComplete: (_handle, result) => {
        this.lastResult = result as typeof this.lastResult;
        this.pendingMessageHandle = undefined;
      },
      createPiSession: async () => {
        const { session } = await createAgentSession({
          cwd,
          agentDir,
          authStorage,
          modelRegistry,
          model: piModel,
          thinkingLevel: this.resolveThinkingLevel(),
          noTools: piConnectorConfig?.noTools,
          customTools,
          resourceLoader,
          sessionManager,
          settingsManager,
        });
        return session;
      },
    });

    await this.session.initialize();
    // Assigned lazily (not at construction) because the Pi session ID is only
    // available after createAgentSession() completes. Qwen-ACP uses the same pattern.
    this.adapterSessionId = this.session.getSessionId();

    // Wire turn lifecycle events after session is created
    this.wireSessionEvents();
  }

  /**
   * Adapter identity context for bus-bridged tool handler calls.
   *
   * `adapterSessionId` and `sessionId` default to empty strings before the
   * session is initialized so early tool fetches produce a well-typed context.
   * @returns Current adapter identity snapshot for tool dispatch routing
   */
  private get toolContext(): PiToolHandlerContext {
    return {
      adapterId: this.adapterId,
      adapterName: this.adapterName,
      agentId: this.agentId,
      sessionId: this.sessionId ?? '',
      cwd: this.cwd,
      env: this.env,
      allowedDirectories: this.config.allowedDirectories,
      getTurnExecutionContext: () => this.session?.getToolExecutionTurnContext() ?? {},
      consumeApprovedToolInput: (toolCallId) => this.session?.consumeApprovedToolInput(toolCallId),
    };
  }

  /**
   * Resolve credentials and build an `AuthStorage`-backed `ModelRegistry`.
   *
   * Registers the Makaio provider so `getAvailable()` includes the requested
   * model. Shared by `initializeSession()` and `changeModelInPlace()`.
   * @param modelId - The model ID to register in the registry
   * @returns Ready-to-use `authStorage`, `modelRegistry`, and resolved `providerName`
   */
  private async buildModelRegistry(
    modelId: string,
  ): Promise<{ authStorage: AuthStorage; modelRegistry: ModelRegistry; providerName: string }> {
    const credentialRefs = this.config.providerContext?.credentialRefs ?? {};
    const credentials = await resolveConnectorCredentials(this.config.bus, credentialRefs);

    const authStorage = AuthStorage.create();
    const providerName = this.config.providerContext?.definitionId ?? 'anthropic';
    const apiKey = credentials['apiKey'];
    if (apiKey) {
      authStorage.setRuntimeApiKey(providerName, apiKey);
    }

    const modelRegistry = ModelRegistry.create(authStorage);
    const credentialEnvVar = this.config.providerContext?.credentialEnvVars?.['apiKey'];
    registerMakaioProviderModel(
      modelRegistry,
      providerName,
      modelId,
      this.config.providerContext?.endpointOverrides,
      apiKey ?? credentialEnvVar,
    );

    return { authStorage, modelRegistry, providerName };
  }

  /**
   * Resolve the Pi SDK model object from the model registry.
   *
   * Falls back to undefined (Pi SDK default) when no match is found so that
   * a missing model entry does not block session creation.
   * @param modelRegistry - Pi's ModelRegistry instance with auth storage
   * @returns Resolved Pi Model, or undefined if no match found
   */
  private async resolvePiModel(modelRegistry: ModelRegistry): Promise<Model<never> | undefined> {
    const available = await modelRegistry.getAvailable();
    const providerName = this.config.providerContext?.definitionId ?? 'anthropic';
    const modelId = this.model;
    const found = available.find((m) => m.id === modelId && m.provider === providerName);
    if (!found) {
      console.warn(`[PiConnector] Model '${providerName}/${modelId}' not found in registry — using Pi SDK default`);
    }
    return found as Model<never> | undefined;
  }

  /**
   * Normalize the system prompt to DefaultResourceLoader override callbacks.
   * @param systemPrompt - The Makaio system prompt (string or append-mode object)
   * @returns Resource-loader prompt override callbacks
   */
  private resolveSystemPromptOptions(
    systemPrompt: SystemPrompt | undefined,
  ): Pick<
    ConstructorParameters<typeof DefaultResourceLoader>[0],
    'systemPromptOverride' | 'appendSystemPromptOverride'
  > {
    if (systemPrompt === undefined) return {};
    if (typeof systemPrompt === 'string') {
      return {
        systemPromptOverride: () => systemPrompt,
      };
    }
    return {
      appendSystemPromptOverride: (base) => [...base, systemPrompt.content],
    };
  }

  /**
   * Map the connector's reasoning effort level to Pi's thinking level.
   * @returns Pi SDK ThinkingLevel string
   */
  private resolveThinkingLevel(): PiThinkingLevel {
    // Map the Makaio AIReasoningLevel to Pi's ThinkingLevel
    const effort = this.currentReasoningEffort;
    if (effort && REASONING_TO_THINKING[effort]) {
      return REASONING_TO_THINKING[effort];
    }
    return 'medium'; // Pi SDK default
  }

  /** Refresh registry custom tools and push them to the Pi session. No-ops without a session. */
  private async refreshRegistryTools(): Promise<void> {
    if (!this.session) return;
    try {
      const tools = await fetchToolsForPi(this.adapterId, this.adapterName, this.toolContext);
      this.session.updateCustomTools(tools);
    } catch (error) {
      console.warn('[PiConnector] Tool refresh failed:', error);
    }
  }

  // ---------------------------------------------------------------------------
  // Connector API
  // ---------------------------------------------------------------------------

  /**
   * Start the connector with an initial user message.
   * @param message - The initial user message
   * @param options - Optional start options including system prompt
   * @returns Session ID, agent ID, and message handle
   */
  public override async start(
    message: NormalizedMessageInput,
    options?: ConnectorStartOptions,
  ): Promise<AgentStartResult> {
    this.captureSystemPrompt(options?.systemPrompt);
    const messageHandle = await this.sendMessage(message, options);
    return {
      adapterSessionId: await this.getAdapterSessionId(),
      messageHandle,
      agentId: this.agentId,
    };
  }

  /**
   * Send a message to the Pi session.
   *
   * Creates a message handle, enqueues it, and processes the queue via the
   * inherited `processUserMessages()` which delegates to the session.
   * @param message - The user message to send
   * @param options - Optional delivery mode options
   * @returns Message handle for tracking acknowledgment and completion
   */
  public async sendMessage(
    message: NormalizedMessageInput,
    options?: ConnectorSendMessageOptions,
  ): Promise<MessageHandle> {
    // Initialize the session first so adapterSessionId is available when
    // createMessageHandle fires onMessageSent (which emits user_message.sent).
    await this.ensureSession();
    const handle = this.createMessageHandle(message, options);
    await this.processUserMessages([handle]);
    return handle;
  }

  /**
   * Interrupt the current turn by calling Pi's `session.abort()`.
   *
   * Pi reuses the same session after abort — the next `session.prompt()` call
   * starts a new turn in the same conversation context.
   */
  public async interrupt(): Promise<void> {
    await this.session?.abort();
  }

  /**
   * Abort the connector (fire-and-forget).
   *
   * Signals Pi's agentic loop to stop at the next safe point.
   */
  public override abort(): void {
    void this.session?.abort();
  }

  /**
   * Close the connector and release Pi session resources.
   *
   * Disposes the underlying Pi session, unsubscribing from events and
   * releasing any held references.
   */
  public override async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const initPromise = this.sessionInitPromise;
    if (initPromise) {
      try {
        await initPromise;
      } catch {
        // Initialization failed; there may be no session to clean up.
      }
    }
    await this.session?.close();
    this.session = undefined;
    this.sessionInitPromise = undefined;
  }

  /**
   * Get the Pi session's UUID.
   *
   * Ensures the session is initialized before returning, so callers that race
   * with session creation receive a valid ID rather than `undefined`.
   * @returns The adapter session ID
   */
  public async getAdapterSessionId(): Promise<string> {
    await this.ensureSession();
    return this.adapterSessionId as string;
  }

  /**
   * Change the Pi model in-place via `session.setModel()`.
   *
   * Pi supports mid-session model switching natively, so this always returns
   * `true`. The connector resolves the new model from the registry before
   * calling `setModel()`.
   * @param newModel - The model identifier to switch to
   * @returns Always `true` — Pi supports in-place model switching
   */
  public override async changeModelInPlace(newModel: string): Promise<boolean> {
    if (!this.session) return false;

    const { modelRegistry, providerName } = await this.buildModelRegistry(newModel);

    const available = await modelRegistry.getAvailable();
    const piModel = available.find((m) => m.id === newModel && m.provider === providerName) as Model<never> | undefined;

    if (!piModel) {
      console.warn(`[PiConnector] changeModelInPlace: model '${providerName}/${newModel}' not found`);
      return false;
    }

    await this.session.setModelOnPiSession(piModel);
    return true;
  }

  /**
   * CWD is bound at session creation; in-place change is not supported.
   * @returns Always `false` — a connector swap is required to change cwd
   */
  public override async changeCwdInPlace(): Promise<boolean> {
    return false;
  }

  /**
   * Change Pi thinking level in-place for subsequent model calls.
   * @param newLevel - Makaio reasoning effort level to apply
   * @returns Whether the existing Pi session accepted the update
   */
  public override async changeReasoningInPlace(newLevel: AIReasoningLevel): Promise<boolean> {
    if (!this.session) return false;
    this.session.setThinkingLevelOnPiSession(REASONING_TO_THINKING[newLevel] ?? 'medium');
    return true;
  }

  /**
   * Mark that registry tools need to be refreshed at the start of the next turn.
   *
   * The flag is consumed in `getWireSessionConfig().onTurnStarted` and reset
   * after the refresh attempt (successful or not).
   */
  public override markToolRefreshPending(): void {
    this.toolRefreshPending = true;
  }
}
