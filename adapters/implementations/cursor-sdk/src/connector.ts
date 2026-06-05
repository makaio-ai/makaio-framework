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
  type MessageResult,
} from '@makaio/ai-adapters-core';
import { resolveConnectorCredentials } from '@makaio/ai-adapters-core/config';
import { CursorSdkAdapterName } from './constants.js';
import type { CursorSdkBus } from './namespaces/index.js';
import { CursorSdkSubjects } from './namespaces/index.js';
import type { CursorConnectorConfig } from './types/index.js';
import { CursorSdkSession } from './session.js';

/**
 * Cursor SDK Connector — wraps `Agent.create()` and `agent.send()`.
 *
 * This is the lowest layer in the three-layer adapter architecture:
 * `CursorSdkAdapter` → `CursorSdkAgent` → `CursorSdkConnector`
 *
 * Key behaviors:
 * - Lazy session initialization on first `start()` or `sendMessage()` call
 * - Single-flight init: concurrent callers coalesce on `sessionInitPromise`
 * - Model switching via per-`send()` model parameter (`changeModelInPlace` returns `true`)
 * - CWD is bound at `Agent.create()` time (`changeCwdInPlace` always returns `false`)
 * - MCP tool injection is resolved live by the MCP bridge HTTP sidecar
 */
export class CursorSdkConnector extends ProceduralAgentConnector<CursorSdkBus, CursorConnectorConfig> {
  /** Session instance, created lazily on first use. */
  private session: CursorSdkSession | undefined;

  /**
   * In-flight init promise — coalesces concurrent callers.
   * Cleared on failure so the caller may retry after a transient error.
   */
  private sessionInitPromise: Promise<void> | undefined;

  /** Message queue for delivery mode handling. */
  private readonly sessionMessageQueue = new UserMessageQueue();

  /** Terminal lifecycle guard set after `close()`. */
  private closed = false;

  /**
   * Create a new `CursorSdkConnector` instance.
   * @param config - Fully-resolved connector configuration.
   */
  public constructor(config: CursorConnectorConfig) {
    super({ ...config, adapterName: CursorSdkAdapterName });
  }

  /**
   * Get the current session instance.
   * @returns The session or `undefined` if not yet initialized.
   */
  protected getSession(): ProceduralConnectorSession | undefined {
    return this.session;
  }

  /**
   * Initialize and return the session (single-flight; idempotent).
   *
   * Coalesces concurrent callers via `sessionInitPromise`. Cleared on failure
   * so callers can retry after a transient error.
   * @returns The initialized session.
   * @throws Error when called after `close()`.
   */
  protected async ensureSession(): Promise<ProceduralConnectorSession> {
    if (this.closed) {
      throw new Error('[CursorSdkConnector] Cannot initialize a closed connector');
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
      throw new Error('[CursorSdkConnector] Cannot use a closed connector');
    }
    return this.session!;
  }

  /**
   * Get the message queue for this connector.
   * @returns The session message queue.
   */
  protected getSessionQueue(): UserMessageQueue {
    return this.sessionMessageQueue;
  }

  /**
   * Get namespace turn subjects for `wireSessionEvents`.
   * @returns Turn subject definitions for the Cursor SDK namespace.
   */
  protected getTurnSubjects(): WireSessionSubjects<CursorSdkBus['namespace']> {
    return CursorSdkSubjects.turn;
  }

  /**
   * Initialize the Cursor SDK session.
   *
   * Resolves credentials, creates the `CursorSdkSession`, and wires turn
   * lifecycle events. Called once via `ensureSession()`.
   */
  private async initializeSession(): Promise<void> {
    const apiKey = await this.resolveApiKey();

    const resolvedSystemPrompt =
      this.systemPrompt == null
        ? undefined
        : typeof this.systemPrompt === 'string'
          ? this.systemPrompt
          : this.systemPrompt.content;

    const session = new CursorSdkSession({
      agentId: this.agentId,
      adapterId: this.adapterId,
      adapterName: this.adapterName,
      makaioSessionId: this.sessionId,
      cwd: this.cwd,
      env: this.env,
      model: this.model,
      apiKey,
      systemPrompt: resolvedSystemPrompt,
      providerConfig: this.config.providerConfig,
      bus: this.config.bus,
      onTurnStart: (handle) => {
        this.pendingMessageHandle = handle;
      },
      onTurnComplete: (_handle, result) => {
        this.lastResult = result as MessageResult;
        this.pendingMessageHandle = undefined;
      },
    });

    this.session = session;
    try {
      await session.initialize();
    } catch (err) {
      if (this.session === session) this.session = undefined;
      throw err;
    }
    this.adapterSessionId = session.adapterSessionId;
    this.wireSessionEvents();
  }

  /**
   * Resolve the Cursor API key from provider credentials or environment.
   *
   * Tries `resolveConnectorCredentials` when the provider context carries a
   * credential ref for `apiKey`, then falls back to `CURSOR_API_KEY`.
   * @returns The resolved API key string.
   * @throws Error when no API key can be resolved.
   */
  private async resolveApiKey(): Promise<string> {
    const credentialRefs = this.config.providerContext?.credentialRefs ?? {};
    if (Object.keys(credentialRefs).length > 0) {
      const credentials = await resolveConnectorCredentials(this.config.bus, credentialRefs);
      if (credentials['apiKey']) return credentials['apiKey'];
    }
    const envKey = this.env['CURSOR_API_KEY'] ?? process.env['CURSOR_API_KEY'];
    if (envKey) return envKey;
    throw new Error(
      '[CursorSdkConnector] No API key found. ' +
        'Provide a credential ref for "apiKey" in providerContext, or set CURSOR_API_KEY.',
    );
  }

  /**
   * Initialize the connector without sending a message.
   *
   * Called by `createAgent` for idle agent setup. Idempotent — no-op if the
   * session is already initialized.
   * @param options - Optional start options (e.g., `systemPrompt`).
   */
  public override async initialize(options?: ConnectorStartOptions): Promise<void> {
    if (this.session) return;
    this.captureSystemPrompt(options?.systemPrompt);
    await this.ensureSession();
  }

  /**
   * Start the connector with an initial user message.
   * @param message - The initial user message.
   * @param options - Optional start options including system prompt.
   * @returns Session ID, agent ID, and message handle.
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
   * Send a message to the Cursor SDK session.
   *
   * Initializes the session on first call (so `adapterSessionId` is set before
   * `onMessageSent` fires), enqueues the message, and processes the queue.
   * @param message - The user message to send.
   * @param options - Optional delivery mode options.
   * @returns Message handle for tracking acknowledgment and completion.
   */
  public async sendMessage(
    message: NormalizedMessageInput,
    options?: ConnectorSendMessageOptions,
  ): Promise<MessageHandle> {
    await this.ensureSession();
    const handle = this.createMessageHandle(message, options);
    await this.processUserMessages([handle]);
    return handle;
  }

  /**
   * Get the Cursor Agent ID, ensuring session is initialized first.
   * @returns The adapter session ID.
   */
  public async getAdapterSessionId(): Promise<string> {
    await this.ensureSession();
    return this.adapterSessionId as string;
  }

  /**
   * Interrupt the current run by awaiting run cancellation.
   */
  public async interrupt(): Promise<void> {
    await this.session?.interrupt();
  }

  /**
   * Abort the current run (fire-and-forget).
   */
  public override abort(): void {
    this.session?.abort();
  }

  /**
   * Wait for all messages to finish.
   * @returns Last message result or `null` if no messages processed.
   */
  public async complete(): Promise<MessageResult | null> {
    while (this.getProcessingState() !== 'idle' && this.getProcessingState() !== 'paused') {
      await this.onceProcessingStateChanged();
    }
    return this.lastResult;
  }

  /**
   * Close the connector and release all resources.
   *
   * Awaits any in-flight session init before disposing to avoid teardown races.
   */
  public override async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const initPromise = this.sessionInitPromise;
    if (initPromise) {
      try {
        await initPromise;
      } catch {
        // Initialization failed — there may be no session to clean up.
      }
    }
    await this.session?.close();
    this.session = undefined;
    this.sessionInitPromise = undefined;
  }

  /**
   * Switch model in-place.
   *
   * Cursor SDK accepts the model parameter per-`send()` call, so the new model
   * takes effect on the next turn without requiring a session swap. The session's
   * `updateModel()` is called to propagate the change; the caller
   * (AgentRuntimeMutationManager) owns the `this.model` field update.
   * @param newModel - The model identifier to switch to.
   * @returns Always `true`.
   */
  public override async changeModelInPlace(newModel: string): Promise<boolean> {
    this.session?.updateModel(newModel);
    return true;
  }

  /**
   * CWD is bound at `Agent.create()` time; in-place change is not supported.
   * @returns Always `false` — a connector swap is required.
   */
  public override async changeCwdInPlace(): Promise<boolean> {
    return false;
  }

  /**
   * MCP bridge resolves `tools/list` live per-request; no explicit refresh needed.
   */
  public override markToolRefreshPending(): void {
    // No-op: the MCP bridge resolves tools live per-request.
  }
}
