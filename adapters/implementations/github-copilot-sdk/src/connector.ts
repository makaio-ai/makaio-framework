import { CopilotClient, type SessionConfig } from '@github/copilot-sdk';

import {
  ProceduralAgentConnector,
  type ProceduralConnectorSession,
  type WireSessionSubjects,
  type WireSessionConfig,
  ConnectorSendMessageOptions,
  MessageHandle,
  type NormalizedMessageInput,
  UserMessageQueue,
} from '@makaio/ai-adapters-core';
import type { AIReasoningLevel } from '@makaio/contracts';
import {
  type CopilotSessionEvent,
  type GitHubCopilotConnectorBus,
  GitHubCopilotConnectorNamespace,
  GitHubCopilotConnectorSubjects,
} from './namespaces/index.js';
import pDefer, { DeferredPromise } from 'p-defer';
import { ConsumptionCompleteResult, CopilotSessionOptions } from './types/index.js';
import { GitHubCopilotSdkAdapterName } from './adapter.js';
import { CopilotConnectorSession } from './session.js';
import { toSdkReasoningEffort } from './reasoning.js';
import { buildPermissionHandler } from './permission.js';
import { performSessionInit } from './session-init.js';

// Re-export so external code (including tests) can import toSdkReasoningEffort
// from the connector module without needing to know about the reasoning module.
export { toSdkReasoningEffort } from './reasoning.js';

/** Default adapter identifier for standalone GitHubCopilotConnector instances (without adapter layer) */
const defaultAdapterId = crypto.randomUUID();
const defaultBus = await GitHubCopilotConnectorNamespace.scopedBus();

/**
 * GitHub Copilot Connector - Wraps a Copilot SDK Session for message lifecycle management.
 * Manages event consumption, sessionId, FIFO event buffer, and message queue lifecycle.
 * Note: Session closed events are handled by GitHubCopilotAgent (AIAgent layer).
 *
 * Credential resolution happens in `initializeSession()` via `resolveConnectorCredentials()`.
 * The resolved token is passed to the SDK client through its per-client `githubToken`
 * option, so it is never stored in the connector config or on the bus.
 */
export class GitHubCopilotConnector extends ProceduralAgentConnector<GitHubCopilotConnectorBus> {
  /** Copilot Session instance for message exchange (managed by CopilotConnectorSession). */
  private session?: CopilotConnectorSession;

  private client?: CopilotClient;

  /** Maximum events to retain in FIFO buffer. */
  private readonly maxMessages: number;

  /** Event history buffer (FIFO, capped at maxMessages). */
  private readonly events: CopilotSessionEvent[] = [];

  /** Promise that resolves when consumption completes or errors. */
  protected deferredConsumptionComplete?: DeferredPromise<ConsumptionCompleteResult>;

  /** Default session config (model, tools, etc.). Updated by {@link changeReasoningInPlace}. */
  private defaultSessionConfig: SessionConfig;

  /** Most recent event received. */
  protected lastEvent?: CopilotSessionEvent;

  /** Session-layer queue for Turn-aware processing with merge support. */
  private readonly sessionQueue = new UserMessageQueue();

  /** In-flight session initialization promise for single-flight deduplication. */
  private initSessionPromise?: Promise<void>;
  /** Epoch used to invalidate in-flight session initialization during close(). */
  private sessionLifecycleEpoch = 0;
  /** Provisional client created during session initialization, before publication. */
  private initializingClient?: CopilotClient;
  /** Provisional session created during session initialization, before publication. */
  private initializingSession?: CopilotConnectorSession;

  /**
   * Create a new GitHubCopilotConnector instance.
   * @param config - Configuration including bus, auth, and session config
   */
  public constructor(config: CopilotSessionOptions & { adapterId?: string }) {
    super({
      ...config,
      bus: config?.bus ?? defaultBus,
      adapterId: config?.adapterId ?? defaultAdapterId,
      adapterName: config?.adapterName ?? GitHubCopilotSdkAdapterName,
    });

    // Generate our own adapterSessionId to pass to SDK
    // Base constructor may have already set this from config (swap case)
    this.adapterSessionId ??= crypto.randomUUID();

    // Extract provider-specific config, excluding Makaio-specific fields
    // to prevent Makaio sessionId from being passed to Copilot SDK.
    const { providerConfig } = config;
    // Cast to include `reasoningEffort` so it can be explicitly excluded from
    // the spread. `GitHubCopilotProviderConfig` does not declare this field, but
    // a runtime payload may carry it (e.g. from a misconfigured provider store).
    // Destructuring it out here prevents it from leaking into `SessionConfig`
    // when the canonical mapping for the connector's level produces `undefined`.
    const {
      reasoningEffort: _providerReasoning,
      sessionId: _providerSessionId,
      model: _providerModel,
      streaming: _providerStreaming,
      onPermissionRequest: _providerOnPermissionRequest,
      maxMessages: _providerMaxMessages,
      ...sessionConfigOverrides
    } = (providerConfig ?? {}) as typeof providerConfig & {
      reasoningEffort?: unknown;
      sessionId?: unknown;
      model?: unknown;
      streaming?: unknown;
      onPermissionRequest?: unknown;
      maxMessages?: unknown;
    };

    // Map canonical reasoning level to SDK effort string, if a level was provided.
    const sdkReasoningEffort = this.currentReasoningEffort
      ? toSdkReasoningEffort(this.currentReasoningEffort)
      : undefined;

    // Build session config for the new SDK
    this.defaultSessionConfig = {
      sessionId: this.adapterSessionId,
      model: this.config.model,
      onPermissionRequest: buildPermissionHandler({
        requestToolApproval: (subject, payload) => this.requestToolApproval(subject, payload),
        handleError: (error, terminate) => this.handleError(error, terminate),
        handleToolApprovalDenied: (abort, toolName) => this.handleToolApprovalDenied(abort, toolName),
      }),
      streaming: true,
      // sessionConfigOverrides comes from providerConfig (SDK-specific options
      // like maxTokens). It cannot contain sessionId, model, or streaming —
      // those are connector-owned fields set above from adapter config.
      ...(sessionConfigOverrides || {}),
      // Reasoning effort overrides any provider-level setting for the same field.
      // Omit entirely when undefined so the SDK uses its own default.
      ...(sdkReasoningEffort !== undefined ? { reasoningEffort: sdkReasoningEffort } : {}),
    };
    this.maxMessages = config?.providerConfig?.maxMessages ?? 1000;

    this.deferredConsumptionComplete = pDefer<ConsumptionCompleteResult>();
  }

  // --- ProceduralAgentConnector abstract implementations ---

  /**
   * Get the Copilot session instance.
   * @returns The session or undefined if not yet initialized
   */
  protected getSession(): CopilotConnectorSession | undefined {
    return this.session;
  }

  /**
   * Initialize and return the Copilot session.
   * @returns The initialized session
   */
  protected async ensureSession(): Promise<ProceduralConnectorSession> {
    if (!this.session) {
      await this.initializeSession();
    }
    return this.session!;
  }

  /**
   * Get the message queue for Copilot connector.
   * @returns The session message queue
   */
  protected getSessionQueue(): UserMessageQueue {
    return this.sessionQueue;
  }

  /**
   * Get Copilot namespace turn subjects.
   * @returns Turn subject definitions
   */
  protected getTurnSubjects(): WireSessionSubjects<GitHubCopilotConnectorBus['namespace']> {
    return GitHubCopilotConnectorSubjects.turn;
  }

  /**
   * Copilot-specific turn_finished handling.
   *
   * SDK can have multiple turns per message (e.g., turn 0: report_intent,
   * turn 1: file write). Only go to processing_finished/idle when the
   * message is actually complete.
   * @returns Wire session configuration with custom onTurnFinished
   */
  protected override getWireSessionConfig(): WireSessionConfig {
    return {
      onTurnFinished: async (drainQueue) => {
        const pendingMessage = this.pendingMessageHandle;
        const messageComplete = !pendingMessage || pendingMessage.isProcessed;

        if (messageComplete) {
          await drainQueue();
        }
      },
    };
  }

  // --- Reasoning in-place change ---

  /**
   * Apply a new reasoning effort level without swapping the connector.
   *
   * Always updates {@link defaultSessionConfig} so the next session creation
   * uses the updated effort.
   *
   * Returns `false` when a live session already exists: the Copilot SDK does
   * not support changing reasoning on an active session, so the mutation
   * manager must fall back to a connector swap. Returns `true` only when no
   * session has been created yet (pre-session or between turns), meaning the
   * updated `defaultSessionConfig` is sufficient and no swap is needed.
   *
   * Per the mutation contract in {@link BaseAgentConnector}, this method MUST NOT
   * update `this.currentReasoningEffort` — the caller owns that field.
   * @param newLevel - The new reasoning effort level to apply
   * @returns `true` when no live session exists (change will take effect on
   *   next session creation); `false` when a session is already running
   *   (triggers a connector swap by the mutation manager)
   */
  public override changeReasoningInPlace(newLevel: AIReasoningLevel): Promise<boolean> {
    const sdkEffort = toSdkReasoningEffort(newLevel);
    if (sdkEffort !== undefined) {
      this.defaultSessionConfig = { ...this.defaultSessionConfig, reasoningEffort: sdkEffort };
    } else {
      // 'none' → omit reasoningEffort entirely
      const { reasoningEffort: _removed, ...rest } = this.defaultSessionConfig;
      this.defaultSessionConfig = rest;
    }

    const sessionCreationInFlight = this.initSessionPromise !== undefined || this.initializingSession !== undefined;

    // The Copilot SDK does not support changing reasoning on an active or
    // initializing session. Return false so the mutation manager swaps the
    // connector instead of assuming an in-flight session picked up the change.
    return Promise.resolve(this.session === undefined && !sessionCreationInFlight);
  }

  // --- Session initialization ---

  /**
   * Initialize CopilotConnectorSession for SDK lifecycle management.
   *
   * Resolves credentials from `providerContext.credentialRefs` via the encrypted
   * credential channel, then passes the token to the Copilot SDK client through
   * its per-client `githubToken` option. Plaintext credentials are scoped to
   * this method and the SDK client; they are never stored in connector config.
   *
   * Uses single-flight deduplication — concurrent callers join the same promise
   * so the session is created exactly once.
   * @returns Promise that resolves when the session is ready
   */
  private initializeSession(): Promise<void> {
    if (this.session) return Promise.resolve();
    this.initSessionPromise ??= this.doInitializeSession().finally(() => {
      this.initSessionPromise = undefined;
    });
    return this.initSessionPromise;
  }

  /** Actual session initialization — called once per flight by {@link initializeSession}. */
  private async doInitializeSession(): Promise<void> {
    const initEpoch = this.sessionLifecycleEpoch;

    try {
      const result = await performSessionInit(
        {
          bus: this.config.bus,
          globalBus: this.globalBus,
          adapterId: this.config.adapterId ?? this.adapterId,
          adapterName: this.config.adapterName ?? this.adapterName,
          agentId: this.agentId,
          cwd: this.cwd,
          env: this.env,
          model: this.model,
          defaultSessionConfig: this.defaultSessionConfig,
          systemPrompt: this.systemPrompt,
          providerContext: this.config.providerContext,
          toolLedger: this.config.toolLedger,
          getCurrentTurnNumber: () => this.pendingTurnNumber ?? this.currentTurnNumber,
          allowedTools: this.config.allowedTools,
          disallowedTools: this.config.disallowedTools,
        },
        {
          emitSdkEvent: async (event) => {
            this.logLowLevelEvent(event);
            this.events.push(event);
            if (this.events.length > this.maxMessages) {
              this.events.shift();
            }
            this.lastEvent = event;
            await this.emit(GitHubCopilotConnectorSubjects.sdk.event, event);
          },
          handleError: this.handleError.bind(this),
          onTurnStart: (handle) => {
            this.consumeTurnNumber();
            this.pendingMessageHandle = handle;
          },
          onTurnComplete: (_handle, turnResult) => {
            // Cast is safe: Session produces results with proper outcome/result/error shape
            this.lastResult = turnResult as typeof this.lastResult;
            this.pendingMessageHandle = undefined;
          },
          onProvisionalResources: (client, session) => {
            this.initializingClient = client;
            this.initializingSession = session;
          },
        },
        () => {
          if (initEpoch !== this.sessionLifecycleEpoch) {
            throw new Error('GitHub Copilot session initialization was cancelled');
          }
        },
      );

      if (initEpoch !== this.sessionLifecycleEpoch) {
        await this.closeUnpublishedSession(result);
        throw new Error('GitHub Copilot session initialization was cancelled');
      }

      this.adapterSessionId = result.adapterSessionId;
      this.client = result.client;
      this.session = result.session;

      // wireSessionEvents uses getSession() from its turn handlers; publish the
      // concrete session before wiring so synchronous subscribers never see an
      // uninitialized connector.
      this.wireSessionEvents();
    } finally {
      this.initializingClient = undefined;
      this.initializingSession = undefined;
    }
  }

  /**
   * Close initialized resources that lost the lifecycle race before publication.
   * @param result - Initialized resources that must not be published
   */
  private async closeUnpublishedSession(result: {
    client: CopilotClient;
    session: CopilotConnectorSession;
  }): Promise<void> {
    try {
      await result.session.abort();
    } catch {
      /* best-effort */
    }
    try {
      await result.session.destroy();
    } catch {
      /* best-effort */
    }
    try {
      await result.client.stop();
    } catch {
      /* best-effort */
    }
  }

  /**
   * Get session ID (from session instance).
   * Initializes session if not yet created.
   * @returns The Copilot session ID
   */
  public async getAdapterSessionId(): Promise<string> {
    if (!this.adapterSessionId) {
      await this.initializeSession();
    }
    return this.adapterSessionId!;
  }

  /**
   * Send follow-up message in existing session.
   * @param message - The user message (content and role)
   * @param options - Message options including delivery mode
   * @returns Message handle for tracking
   */
  public async sendMessage(
    message: NormalizedMessageInput,
    options?: ConnectorSendMessageOptions,
  ): Promise<MessageHandle> {
    await this.initializeSession();
    if (!this.session) throw new Error('Session not initialized');

    // Create MessageHandle and enqueue to session's queue
    const handle = this.createMessageHandle(message, options);
    this.sessionQueue.enqueue(handle);

    // Trigger active state transition when starting from idle/paused
    if (this.getProcessingState() === 'idle' || this.getProcessingState() === 'paused') {
      await this.updateProcessingState('active');
    }

    // Process queue - Session will emit turn events
    await this.session.processQueue(this.sessionQueue);

    return handle;
  }

  /** Interrupt the current message processing. Delegates to Session for abort handling. */
  public async interrupt(): Promise<void> {
    await this.session?.abort();
  }

  /**
   * Abort the session and cleanup resources.
   * Note: Session closed event emission is handled by GitHubCopilotAgent (AIAgent layer).
   */
  public abort(): void {
    void this.close();
  }

  /** Gracefully close the session and release resources. */
  public async close(): Promise<void> {
    this.sessionLifecycleEpoch += 1;
    void this.initSessionPromise?.catch(() => undefined);

    const initializingSession = this.initializingSession;
    this.initializingSession = undefined;
    this.initializingClient = undefined;

    // Abort the in-flight session to interrupt any blocking SDK call.
    // The session-init catch block handles destroy/stop for provisional resources
    // after the epoch assertion fires — do not duplicate that cleanup here.
    try {
      await initializingSession?.abort();
    } catch {
      /* best-effort */
    }
    try {
      await this.session?.abort();
    } catch {
      /* best-effort */
    }
    try {
      await this.session?.destroy();
    } catch {
      /* best-effort */
    }
    this.session = undefined;
    try {
      await this.client?.stop();
    } catch {
      /* best-effort */
    }
    this.client = undefined;
  }

  /**
   * Handle error during event processing.
   * Extends base class error handling with GitHubCopilotConnector-specific cleanup.
   * @param error - Error that occurred
   * @param terminate - Whether to abort the agent after handling error
   */
  public handleError(error: unknown, terminate = false): void {
    // Base class handles: error conversion, errorHandler callback, pending message cleanup
    super.handleError(error, terminate);
    // GitHubCopilotConnector-specific: resolve deferred promise if it exists
    const err = error instanceof Error ? error : new Error(String(error));
    this.deferredConsumptionComplete?.resolve({ error: err, lastEvent: this.lastEvent ?? null });
  }
}
