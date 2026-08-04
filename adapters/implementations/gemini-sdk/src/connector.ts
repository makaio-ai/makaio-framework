// NOTE: do NOT change the eslint override on the next line without explicit human approval
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
import type { ResolvedAdapterAuth } from '@makaio/ai-adapters-core/config';
import { type Config, GeminiChat } from '@google/gemini-cli-core';
import { type SystemPrompt } from '@makaio/contracts';
import type { GeminiConnectorConfig } from './types/index.js';
import { type GeminiConnectorBus, GeminiConnectorNamespace, type SdkEvent } from './namespaces/index.js';
import { GeminiConnectorSubjects } from './namespaces/index.js';
import { createGeminiConfig, applyReasoningOverride } from './utils/create-config.js';
import { initGemini } from './utils/init-gemini.js';
import { GeminiConnectorSession } from './session.js';
import { UserMessageQueue } from '@makaio/ai-adapters-core';
import { GeminiSdkAdapterName } from './adapter.js';
import { geminiRateLimiter } from './rate-limiter.js';
import { fetchToolsForGemini, type GeminiRegistryToolDeclaration } from './tool-handling.js';
import { resolveGeminiAuthOptions } from './refresh-auth.js';
import { selectGeminiSdkEnvironment, withGeminiSdkEnvironment } from './gemini-sdk-environment.js';
/** Shared adapter identifier for all GeminiConnector instances in this process. */
const adapterId = crypto.randomUUID();
/** Maximum number of registry tool fetch attempts before giving up and proceeding without them. */
const MAX_REGISTRY_FETCH_ATTEMPTS = 3;
const defaultBus = await GeminiConnectorNamespace.scopedBus();
export class GeminiConnector extends ProceduralAgentConnector<GeminiConnectorBus> {
  /** Gemini CLI core config. */
  private geminiConfig: Config | undefined;
  /** Gemini chat instance for conversation management (created after initialization). */
  private geminiChat?: GeminiChat;
  /** Whether agent has been initialized. */
  private isInitialized = false;
  private sessionInitialization: Promise<GeminiConnectorSession> | undefined;
  /** Whether agent has been terminated/aborted. */
  private isTerminated = false;
  private terminationCleanup: Promise<void> | undefined;
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
  private readonly adapterAuth: ResolvedAdapterAuth | undefined;

  public constructor(config: GeminiConnectorConfig) {
    const { adapterAuth, ...baseConfig } = config;
    super({
      ...baseConfig,
      env: baseConfig.env ?? {},
      bus: config?.bus ?? defaultBus,
      adapterId: config?.adapterId ?? adapterId, // Prefer config's adapterId, fallback to module default
      adapterName: GeminiSdkAdapterName,
    });
    this.adapterAuth = adapterAuth;
  }

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
    this.assertOpen();
    if (this.session) return this.session;
    if (this.sessionInitialization) return await this.sessionInitialization;

    // Publish the shared promise before initialization can re-enter and terminate.
    const initialization = Promise.resolve().then(async () => await this.createSession());
    this.sessionInitialization = initialization;
    void initialization.then(
      () => {
        if (this.sessionInitialization === initialization) this.sessionInitialization = undefined;
      },
      () => {
        if (this.sessionInitialization === initialization) this.sessionInitialization = undefined;
      },
    );
    return await initialization;
  }

  /**
   * Create the SDK chat and session once for the connector.
   * @returns - The new session.
   */
  private async createSession(): Promise<GeminiConnectorSession> {
    this.assertOpen();
    // Tool fetch failures do not block session startup; subsequent calls retry.
    if (!this.registryToolsFetched) {
      await this.fetchTools();
    }
    this.assertOpen();
    if (!this.isInitialized) {
      await this.ensureInitialized();
      this.assertOpen();
      await this.emitSdkEvent({
        type: 'session.created',
        cwd: this.cwd,
        model: this.model ?? 'unknown',
      });
    }
    this.assertOpen();
    return await this.initializeSession();
  }

  protected getSessionQueue(): UserMessageQueue {
    return this.sessionMessageQueue;
  }

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
      this.registryToolDeclarations = await fetchToolsForGemini(this.globalBus, this.adapterId, this.adapterName, {
        allowedTools: this.config.allowedTools,
        disallowedTools: this.config.disallowedTools,
      });
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

  /** Initialize Config and GeminiChat through the rate-limited SDK boundary. @returns - Nothing. */
  private async ensureInitialized(): Promise<void> {
    this.assertOpen();
    if (this.isInitialized) return;

    const result = await geminiRateLimiter.add(
      async () => {
        if (this.isInitialized || this.isTerminated) return undefined;
        // This global harness lookup stays behind the queued termination check.
        const disabledNativeTools = await resolveDisabledNativeTools(
          this.globalBus,
          this.adapterName,
          this.config.harnessId,
          this.config.clientId,
        );
        if (this.isTerminated) return undefined;
        const selection = selectGeminiSdkEnvironment(this.env);
        return await withGeminiSdkEnvironment(selection, async () => {
          this.assertOpen();
          const authOptions = resolveGeminiAuthOptions(this.adapterAuth);
          const geminiConfig =
            this.geminiConfig ??
            createGeminiConfig({
              ...this.config,
              sessionId: this.config.adapterSessionId,
            });
          this.geminiConfig = geminiConfig;
          this.adapterSessionId = geminiConfig.getSessionId();
          return await initGemini(geminiConfig, disabledNativeTools, authOptions, this.registryToolDeclarations);
        });
      },
      { priority: 0 },
    );
    if (result === undefined) {
      this.assertOpen();
      return;
    }
    this.assertOpen();
    this.geminiChat = result.geminiChat;
    this.baseSystemInstruction = result.baseSystemInstruction;
    this.applySystemPrompt();
    this.isInitialized = true;
  }

  /**
   * Initialize the session lifecycle.
   * @returns - The new session.
   */
  private async initializeSession(): Promise<GeminiConnectorSession> {
    if (!this.geminiChat) {
      throw new Error('GeminiChat not initialized');
    }
    const bus = this.config.bus ?? (await GeminiConnectorNamespace.scopedBus(this.globalBus.getContext()));
    this.assertOpen();

    this.session = new GeminiConnectorSession({
      bus,
      globalBus: this.globalBus,
      adapterId: this.config.adapterId ?? '',
      adapterName: this.config.adapterName ?? '',
      agentId: this.agentId,
      cwd: this.cwd,
      model: this.model ?? '',
      env: this.config.env ?? {},
      geminiConfig: this.requireGeminiConfig(),
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

    this.wireSessionEvents();
    return this.session;
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
    void this.beginTermination();
  }

  /** Gracefully close the session. */
  public async close(): Promise<void> {
    await this.beginTermination();
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

  private beginTermination(): Promise<void> {
    if (this.terminationCleanup === undefined) {
      this.isTerminated = true;
      this.terminationCleanup = this.abortAfterInitialization();
    }
    return this.terminationCleanup;
  }

  private async abortAfterInitialization(): Promise<void> {
    try {
      await this.sessionInitialization;
    } catch {
      // A failed initialization cannot own a session, but a partially created one can.
    }
    await this.session?.abort();
  }

  private assertOpen(): void {
    if (this.isTerminated) throw new Error('Gemini connector is closed.');
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
    const geminiConfig = await this.ensureGeminiConfig();
    geminiConfig.setModel(newModel);

    // Re-register thinking override for the new model name.
    // The original override (from createGeminiConfig) targets the old model via `match: { model }`.
    // Use currentReasoningEffort rather than the immutable config field so that any
    // in-place reasoning change applied after construction is reflected here.
    if (this.currentReasoningEffort) {
      applyReasoningOverride(geminiConfig, newModel, this.currentReasoningEffort);
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

    applyReasoningOverride(await this.ensureGeminiConfig(), this.model, newLevel);
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
  public async getModelMutationConfig(): Promise<Pick<Config, 'setModel' | 'getModel' | 'modelConfigService'>> {
    return await this.ensureGeminiConfig();
  }

  private async ensureGeminiConfig(): Promise<Config> {
    if (this.geminiConfig !== undefined) return this.geminiConfig;
    return await withGeminiSdkEnvironment(selectGeminiSdkEnvironment(this.env), async () => {
      if (this.geminiConfig === undefined) {
        this.geminiConfig = createGeminiConfig({ ...this.config, sessionId: this.config.adapterSessionId });
        this.adapterSessionId = this.geminiConfig.getSessionId();
      }
      return this.geminiConfig;
    });
  }

  private requireGeminiConfig(): Config {
    if (this.geminiConfig === undefined) throw new Error('Gemini config was not initialized.');
    return this.geminiConfig;
  }
}
