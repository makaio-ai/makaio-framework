// NOTE: do NOT change without explicit human approval
/* eslint max-lines: ["error", { "max": 500 }] */
import {
  ProceduralAgentConnector,
  resolveDisabledNativeTools,
  type ProceduralConnectorSession,
  type WireSessionSubjects,
  type NormalizedMessageInput,
  type AIReasoningLevel,
  MessageHandle,
  ConnectorSendMessageOptions,
  ConnectorStartOptions,
  type AgentStartResult,
} from '@makaio/ai-adapters-core';
import { resolveConnectorCredentials } from '@makaio/ai-adapters-core/config';
import { type Config, GeminiChat } from '@google/gemini-cli-core';
import { MakaioBus } from '@makaio/bus-core';
import { type SystemPrompt } from '@makaio/contracts';
import type { GeminiConnectorConfig } from './types/index.js';
import { type GeminiConnectorBus, GeminiConnectorNamespace, type SdkEvent } from './namespaces/index.js';
import { GeminiConnectorSubjects } from './namespaces/index.js';
import { createGeminiConfig, applyReasoningOverride } from './utils/create-config.js';
import { buildGeminiAuthOptions, initGemini } from './utils/init-gemini.js';
import { GeminiConnectorSession } from './session.js';
import { UserMessageQueue } from '@makaio/ai-adapters-core';
import { GeminiSdkAdapterName } from './adapter.js';
import { geminiRateLimiter } from './rate-limiter.js';
import { fetchToolsForGemini, type GeminiRegistryToolDeclaration } from './tool-handling.js';

/** Shared adapter identifier for all GeminiConnector instances in this process. */
const adapterId = crypto.randomUUID();
/** Maximum number of registry tool fetch attempts before giving up and proceeding without them. */
const MAX_REGISTRY_FETCH_ATTEMPTS = 3;
/** Env var read by gemini-cli-core for system settings file isolation. */
const GEMINI_SYSTEM_SETTINGS_ENV = 'GEMINI_CLI_SYSTEM_SETTINGS_PATH';
const defaultBus = await GeminiConnectorNamespace.scopedBus();

/**
 * Gemini SDK Connector - Wraps the Gemini SDK for agentic chat completions.
 *
 * This is the lowest layer in the three-layer architecture:
 * - GeminiAdapter (AIAdapter) -\> GeminiAgent (AIAgent) -\> GeminiConnector (AIAgentConnector)
 *
 * Implements the agentic loop pattern:
 * 1. Send user message to Gemini
 * 2. Process streaming response from Turn.run() generator
 * 3. If tool_calls present, execute tools and recurse
 * 4. When no tool_calls, mark turn complete
 */
export class GeminiConnector extends ProceduralAgentConnector<GeminiConnectorBus> {
  /** Gemini CLI core config. */
  private readonly geminiConfig: Config;
  /** Gemini chat instance for conversation management (created after initialization). */
  private geminiChat?: GeminiChat;
  /** Whether agent has been initialized. */
  private isInitialized = false;
  /** Whether agent has been terminated/aborted. */
  private isTerminated = false;
  /** SDK's base system instruction (from initGemini, with memory instructions stripped). */
  private baseSystemInstruction?: string;
  /** Session manages Turn lifecycle. */
  private session?: GeminiConnectorSession;
  /** Message queue for delivery mode handling. */
  private readonly sessionMessageQueue = new UserMessageQueue();
  /** Registry tool declarations loaded lazily before session creation. */
  private registryToolDeclarations: GeminiRegistryToolDeclaration[] = [];
  /** Fast lookup set of registry tool names for execution routing. */
  private registryToolNames: ReadonlySet<string> = new Set();
  /** Whether registry tools have been fetched (guards against refetch on empty registry). */
  private registryToolsFetched = false;
  /** Number of registry fetch attempts made (bounds retries on persistent failure). */
  private registryFetchAttempts = 0;

  /**
   * Create a new GeminiConnector instance.
   * @param config - Configuration including bus, model, cwd
   */
  public constructor(config: GeminiConnectorConfig) {
    super({
      ...config,
      bus: config?.bus ?? defaultBus,
      adapterId: config?.adapterId ?? adapterId, // Prefer config's adapterId, fallback to module default
      adapterName: GeminiSdkAdapterName,
    });
    const previousSettingsPath = process.env[GEMINI_SYSTEM_SETTINGS_ENV];
    const isolatedSettingsPath = this.env[GEMINI_SYSTEM_SETTINGS_ENV];
    try {
      // gemini-cli-core reads this process env var during Config construction.
      // Scope the mutation to construction so one connector cannot leak its
      // isolated settings path into later in-process Gemini connectors.
      if (isolatedSettingsPath === undefined) delete process.env[GEMINI_SYSTEM_SETTINGS_ENV];
      else {
        process.env[GEMINI_SYSTEM_SETTINGS_ENV] = isolatedSettingsPath;
      }
      this.geminiConfig = createGeminiConfig({
        ...this.config,
        sessionId: this.config.adapterSessionId,
      });
    } finally {
      if (previousSettingsPath === undefined) {
        delete process.env[GEMINI_SYSTEM_SETTINGS_ENV];
      } else {
        process.env[GEMINI_SYSTEM_SETTINGS_ENV] = previousSettingsPath;
      }
    }
    this.adapterSessionId = this.geminiConfig.getSessionId();
  }

  // --- ProceduralAgentConnector abstract implementations ---

  /**
   * Get the Gemini session instance.
   * @returns The session or undefined if not yet initialized
   */
  protected getSession(): GeminiConnectorSession | undefined {
    return this.session;
  }

  /**
   * Initialize and return the Gemini session (including SDK initialization).
   * @returns The initialized session
   */
  protected async ensureSession(): Promise<ProceduralConnectorSession> {
    // Design: session creation is not gated on fetchTools success. The session starts
    // immediately with whatever tools are available; fetchTools retries on subsequent
    // turns via the registryToolsFetched flag. Blocking session creation on registry
    // availability would prevent the user from starting any conversation when the
    // registry is temporarily down.
    if (!this.registryToolsFetched) {
      await this.fetchTools();
    }
    if (!this.isInitialized) {
      await this.ensureInitialized();
      await this.emitSdkEvent({
        type: 'session.created',
        cwd: this.cwd,
        model: this.model ?? 'unknown',
      });
    }
    if (!this.session) {
      await this.initializeSession();
    }
    return this.session!;
  }

  /**
   * Get the message queue for Gemini connector.
   * @returns The session message queue
   */
  protected getSessionQueue(): UserMessageQueue {
    return this.sessionMessageQueue;
  }

  /**
   * Get Gemini namespace turn subjects.
   * @returns Turn subject definitions
   */
  protected getTurnSubjects(): WireSessionSubjects<GeminiConnectorBus['namespace']> {
    return GeminiConnectorSubjects.turn;
  }

  protected override getWireSessionConfig() {
    return {
      onTurnStarted: () => {
        this.consumeTurnNumber();
      },
    };
  }

  /**
   * Check if agent can accept immediate messages for context injection.
   * Returns true if:
   * - No session exists (immediate can start a new session)
   * - No turn exists (immediate is first message)
   * - Turn is active and can accept (immediate during turn)
   * @returns True if agent can accept immediate messages
   */
  protected override acceptsImmediate(): boolean {
    // If no session or no turn, immediate can start a new session/turn
    if (!this.session || !this.session.getCurrentTurn()) {
      return true;
    }
    // Otherwise, delegate to turn's canAcceptImmediate
    return this.session.getCurrentTurn()!.canAcceptImmediate();
  }

  // --- SDK and session initialization ---

  /**
   * Emit SDK event to the catch-all sdk.event subject.
   * Uses type assertion to work around Forbid type breaking discriminated union inference.
   * @param event - The SDK event to emit (must match SdkEvent discriminated union)
   * @returns Promise that resolves when the event is emitted
   */
  protected emitSdkEvent(event: SdkEvent): Promise<void> {
    return this.emit(GeminiConnectorSubjects.sdk.event, event as never);
  }

  /**
   * Load registry tools for this adapter instance.
   * Called before session initialization so declarations are available for GeminiChat construction.
   * Registry tools are optional — fetch failures are logged as warnings and fall back to empty.
   */
  private async fetchTools(): Promise<void> {
    this.registryFetchAttempts += 1;
    try {
      this.registryToolDeclarations = await fetchToolsForGemini(this.globalBus, this.adapterId, this.adapterName);
      this.registryToolNames = new Set(this.registryToolDeclarations.map((t) => t.name));
      this.registryToolsFetched = true;
    } catch (error) {
      console.warn('[GeminiConnector] Failed to fetch registry tools, proceeding without them:', error);
      this.registryToolDeclarations = [];
      this.registryToolNames = new Set();
      if (this.registryFetchAttempts >= MAX_REGISTRY_FETCH_ATTEMPTS) {
        console.warn(`[GeminiConnector] Registry tool fetch failed ${this.registryFetchAttempts} times — giving up.`);
        this.registryToolsFetched = true;
      }
      // registryToolsFetched stays false until the attempt cap is reached,
      // so subsequent ensureSession() calls retry up to MAX_REGISTRY_FETCH_ATTEMPTS.
    }
  }

  /** Initialize Config and create GeminiChat.
   * Rate-limited because initialization makes API calls (auth refresh, experiments, etc.).
   * Registry tools are already loaded by ensureSession before this is called.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.isInitialized) return;

    // Resolve credentials locally before initializing the SDK.
    // Preserve explicit credential presence here instead of truthiness.
    // `initGemini()` is the single owner of "blank key is invalid" vs
    // "auth omitted means OAuth fallback" semantics.
    const credentialRefs = this.config.providerContext?.credentialRefs ?? {};
    const credentials = await resolveConnectorCredentials(this.config.bus, credentialRefs);
    const authOptions = buildGeminiAuthOptions(credentials);

    // Harness lookups remain global-bus scoped: harness subjects live in the
    // global namespace, while credential refs resolve through the connector bus.
    const disabledNativeTools = await resolveDisabledNativeTools(
      MakaioBus,
      this.adapterName,
      this.config.harnessId,
      this.config.clientId,
    );
    const result = await geminiRateLimiter.add(
      async () => initGemini(this.geminiConfig, disabledNativeTools, this.registryToolDeclarations, authOptions),
      { priority: 0 },
    );
    this.geminiChat = result.geminiChat;
    this.baseSystemInstruction = result.baseSystemInstruction;
    this.applySystemPrompt();
    this.isInitialized = true;
  }

  /**
   * Initialize Session for SDK lifecycle management.
   * Called on first start() to setup Session/Turn abstractions.
   */
  private async initializeSession(): Promise<void> {
    if (!this.geminiChat) {
      throw new Error('GeminiChat not initialized');
    }

    this.session = new GeminiConnectorSession({
      bus: this.config.bus ?? (await GeminiConnectorNamespace.scopedBus()),
      adapterId: this.config.adapterId ?? '',
      adapterName: this.config.adapterName ?? '',
      agentId: this.agentId,
      cwd: this.cwd,
      model: this.model ?? '',
      env: this.config.env ?? {},
      geminiConfig: this.geminiConfig,
      geminiChat: this.geminiChat,
      emitSdkEvent: this.emitSdkEvent.bind(this),
      handleError: this.handleError.bind(this),
      requestToolApproval: this.requestToolApproval.bind(this),
      registryToolNames: this.registryToolNames,
      onTurnStart: (handle) => {
        this.pendingMessageHandle = handle;
      },
      onTurnComplete: (_handle, result) => {
        this.lastResult = result as typeof this.lastResult;
        this.pendingMessageHandle = undefined;
      },
      toolLedger: this.config.toolLedger,
      getCurrentTurnNumber: () => this.currentTurnNumber,
    });

    // Wire turn events AFTER session is created
    this.wireSessionEvents();
  }

  /**
   * Create and enqueue a message, initializing the session if needed.
   * @param message - The user message to send
   * @param options - Message options including delivery mode and message history
   * @returns Object containing the message handle
   */
  private async createInitialMessage(
    message: NormalizedMessageInput,
    options?: ConnectorSendMessageOptions,
  ): Promise<{ handle: MessageHandle }> {
    await this.ensureSession();

    // Create message handle and enqueue directly to local queue
    const handle = this.createMessageHandle(message, options);
    this.sessionMessageQueue.enqueue(handle);

    // Trigger active state transition when starting from idle/paused
    if (this.getProcessingState() === 'idle' || this.getProcessingState() === 'paused') {
      await this.updateProcessingState('active');
    }

    return { handle };
  }

  /**
   * Start session with initial prompt.
   * @param message - The initial user message
   * @param options - Message options including delivery mode
   * @returns Session ID, agent ID, and message handle
   */
  public override async start(
    message: NormalizedMessageInput,
    options?: ConnectorStartOptions | undefined,
  ): Promise<AgentStartResult> {
    this.captureSystemPrompt(options?.systemPrompt);
    const { handle } = await this.createInitialMessage(message, options);

    // Process queue - Session will start new turn
    await this.session!.processQueue(this.sessionMessageQueue);

    return {
      adapterSessionId: this.adapterSessionId!,
      messageHandle: handle,
      agentId: this.agentId,
    };
  }

  /**
   * Send follow-up message in existing session.
   * @param message - The user message
   * @param options - Message options
   * @returns Message handle for tracking
   */
  public async sendMessage(
    message: NormalizedMessageInput,
    options?: ConnectorSendMessageOptions,
  ): Promise<MessageHandle> {
    const { handle } = await this.createInitialMessage(message, options);

    // Process queue - Session will start new turn or inject into current
    await this.session!.processQueue(this.sessionMessageQueue);

    return handle;
  }

  /** Abort the session and cleanup resources. */
  public abort(): void {
    if (this.isTerminated) return;
    this.isTerminated = true;
    void this.session?.abort();
  }

  /** Gracefully close the session. */
  public async close(): Promise<void> {
    if (this.isTerminated) return;
    this.isTerminated = true;
    await this.session?.abort();
  }

  /**
   * Get session ID, waiting for it to be set if not yet available.
   * @returns The session ID
   */
  public async getAdapterSessionId(): Promise<string> {
    return this.adapterSessionId as string;
  }

  /**
   * Interrupt the current turn.
   */
  public async interrupt(): Promise<void> {
    await this.session?.abort();
  }

  /**
   * Capture runtime system prompt and apply it to GeminiChat.
   * Override to call applySystemPrompt for SDK-specific side effect.
   * @param prompt - System prompt from start/initialize options
   */
  protected override captureSystemPrompt(prompt: SystemPrompt | undefined): void {
    super.captureSystemPrompt(prompt);
    this.applySystemPrompt();
  }

  /**
   * Apply the runtime system prompt to GeminiChat via setSystemInstruction.
   * - String (replace mode): replaces the SDK's system instruction entirely
   * - Append mode: appends to the SDK's base system instruction
   */
  private applySystemPrompt(): void {
    if (this.systemPrompt === undefined || !this.geminiChat) return;

    if (typeof this.systemPrompt === 'string') {
      this.geminiChat.setSystemInstruction(this.systemPrompt);
    } else {
      // Append mode: combine base instruction with runtime content
      const base = this.baseSystemInstruction ?? '';
      this.geminiChat.setSystemInstruction(
        base ? `${base}\n\n${this.systemPrompt.content}` : this.systemPrompt.content,
      );
    }
  }

  /**
   * Change model via Gemini Config.setModel() and re-register thinking override.
   *
   * Reads `currentReasoningEffort` (not `config.reasoningEffort`) so that any
   * reasoning level applied after construction via `changeReasoningInPlace` is
   * preserved when the model changes.
   * @param newModel - The model identifier to switch to
   * @returns Always true — Gemini Config is mutable
   */
  public override async changeModelInPlace(newModel: string): Promise<boolean> {
    this.geminiConfig.setModel(newModel);

    // Re-register thinking override for the new model name.
    // The original override (from createGeminiConfig) targets the old model via `match: { model }`.
    // Use currentReasoningEffort rather than the immutable config field so that any
    // in-place reasoning change applied after construction is reflected here.
    if (this.currentReasoningEffort) {
      applyReasoningOverride(this.geminiConfig, newModel, this.currentReasoningEffort);
    }

    return true;
  }

  /**
   * Apply reasoning effort in-place by registering a new thinking-config override.
   *
   * Validates the requested level against `supportedReasoningLevels` before applying.
   * When no levels are declared the model does not support reasoning, so we return
   * `false` and let the caller fall back to a connector swap.
   *
   * **Mutation contract:** Does NOT mutate `this.currentReasoningEffort`.
   * The caller (AgentRuntimeMutationManager) owns that field update after a
   * successful in-place change.
   * @param newLevel - The new reasoning effort level to apply
   * @returns `true` if the override was registered, `false` if a connector swap is needed
   */
  public override async changeReasoningInPlace(newLevel: AIReasoningLevel): Promise<boolean> {
    // If no supported levels are declared, this model does not support reasoning.
    if (!this.supportedReasoningLevels || !(newLevel in this.supportedReasoningLevels)) {
      return false;
    }

    applyReasoningOverride(this.geminiConfig, this.model, newLevel);
    return true;
  }

  /**
   * Exposes the mutable config surface used by model mutation logic.
   *
   * This is an intentional seam for focused tests of `changeModelInPlace()`.
   * We expose a narrow, typed surface instead of reaching into private fields
   * with reflection, which is brittle and obscures the real contract.
   * @returns Config operations used by in-place model mutation logic
   */
  public getModelMutationConfig(): Pick<Config, 'setModel' | 'getModel' | 'modelConfigService'> {
    return this.geminiConfig;
  }
}
