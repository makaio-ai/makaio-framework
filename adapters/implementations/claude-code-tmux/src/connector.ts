/** Claude Code tmux connector: hook-driven lifecycle over an interactive tmux session. */

import {
  AIAgentConnector,
  UserMessageQueue,
  type MessageHandle,
  type MessageResult,
  type NormalizedMessageInput,
  type AgentStartResult,
  type ConnectorSendMessageOptions,
  type ConnectorStartOptions,
} from '@makaio/ai-adapters-core';
import { resolveSessionEnvironment } from '@makaio/ai-adapters-core/config';
import { readClaudeProviderBaseUrl, resolveClaudeProcessEnv } from '@makaio/ai-adapters-claude-process-shared';
import { MakaioBus } from '@makaio/bus-core';
import { isTmuxAvailable, TmuxBackend } from '@makaio/subsystem-native-session-supervisor';
import { ClaudeCodeClientSubjects } from '@makaio/client-claude-code/runtime';
import { McpSubjects } from '@makaio/contracts';
import { ClientSubjects } from '@makaio/contracts/client';
import { TmuxSession } from './session.js';
import { ClaudeCodeTmuxConnectorSubjects, type ClaudeCodeTmuxConnectorBus } from './namespace/index.js';
import { ADAPTER_NAME, DEFAULT_INTERRUPT_SETTLE_MS, TMUX_SERVER_NAME } from './constants.js';
import type { ClaudeCodeTmuxAgentConfig, ITmuxPtyProcess } from './types.js';
import { TmuxConnectorSession } from './connector-session.js';
import { resolveHookEnvPairs } from './utils/hook-env.js';
import { addMcpServerToProject, removeMcpServerFromProject } from './utils/mcp-settings.js';
import { buildSpawnArgs } from './utils/spawn-args.js';
import { withTimeout } from './utils/timeout.js';
import { prepareLaunchPrerequisites } from './utils/launch-prerequisites.js';
import { subscribeToEarlySessionStart } from './utils/early-session-start.js';
import { subscribeConnectorHooks } from './utils/session-hook-subscription.js';

/**
 * Connector for the Claude Code tmux adapter.
 */
export class ClaudeCodeTmuxConnector extends AIAgentConnector<ClaudeCodeTmuxConnectorBus, ClaudeCodeTmuxAgentConfig> {
  private tmuxSession: TmuxSession | undefined;
  private connectorSession: TmuxConnectorSession | undefined;
  private userMessageQueue: UserMessageQueue | undefined;
  private backend: TmuxBackend | undefined;
  private processExitDisposable: ReturnType<ITmuxPtyProcess['onExit']> | undefined;
  /** Whether turn event wiring has already been set up. */
  private turnEventsWired = false;
  /** Unsubscribe functions registered by wireSessionEvents(), cleared in teardown(). */
  private sessionEventCleanups: Array<() => void> = [];
  /** Unsubscribe function returned by TmuxSession.subscribeToHooks(). */
  private hookUnsubscribe: (() => void) | undefined;
  /** Claude Code session ID, generated upfront and passed via --session-id. */
  private readonly claudeSessionId: string;
  private registeredMcpSessionId: string | undefined;
  private readonly installedMcpServerNames = new Set<string>();
  /**
   * In-flight initialization promise. Guards against concurrent calls to
   * initializeSession() when multiple sendMessage() / initialize() calls
   * arrive before the first initialization completes.
   */
  private initializationPromise: Promise<void> | undefined;
  /**
   * Monotonic lifecycle token. Teardown increments it so any in-flight
   * initialization can detect that ownership of handles has been revoked.
   */
  private lifecycleToken = 0;

  /**
   * Create a ClaudeCodeTmuxConnector bound to one agent instance.
   *
   * Generates the Claude Code session ID upfront so it is available for
   * hook correlation before Claude Code is spawned.
   * @param config - Connector configuration including bus, adapter identity, and provider config.
   */
  public constructor(config: ClaudeCodeTmuxAgentConfig) {
    super({
      ...config,
      adapterName: config.adapterName ?? ADAPTER_NAME,
    });
    this.claudeSessionId = crypto.randomUUID();
    this.adapterSessionId = this.claudeSessionId;
  }

  // ---------------------------------------------------------------------------
  // Private: session initialisation
  // ---------------------------------------------------------------------------

  /**
   * Resolve process environment for spawning Claude Code.
   * @returns Spawn environment with API key and base URL mapped to Anthropic names.
   */
  private async resolveSpawnEnv(): Promise<Record<string, string>> {
    const { credentials, spawnEnv } = await resolveSessionEnvironment({
      bus: this.config.bus,
      providerContext: this.config.providerContext,
      clientId: 'claude-code',
      baseEnv: this.env,
    });

    return resolveClaudeProcessEnv({
      spawnEnv,
      credentials,
      providerContext: this.config.providerContext,
      baseUrl: readClaudeProviderBaseUrl(this.config.providerConfig),
    });
  }

  /**
   * Ensure Claude Code hooks are wired to call back into Makaio.
   *
   * Sends a `wiring.apply` bus request to the Claude Code client service, which
   * writes hook entries into the session-scoped user settings file. This must
   * complete before Claude Code is spawned — it reads the config at startup.
   * @param projectDir - Absolute path to the project root.
   * @param configDir - Session-scoped config directory where user-scope
   *   settings are written.
   */
  private async ensureHookWiring(projectDir: string, configDir: string): Promise<void> {
    const makaioCommand = process.argv[1] ?? 'makaio';
    try {
      await MakaioBus.request(ClaudeCodeClientSubjects.wiring.apply, {
        scope: 'user',
        projectDir,
        makaioCommand,
        envPairs: resolveHookEnvPairs(),
        configDir,
        skipDangerousModePermissionPrompt: this.config.providerConfig?.skipPermissions !== false,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Claude Code tmux requires active Claude Code wiring support: ${reason}`);
    }
  }

  /**
   * Register the long-lived tmux adapter session with the MCP bridge and write
   * the Makaio HTTP server entry into Claude Code's project `.mcp.json`.
   *
   * The server entry uses a session-scoped name (`makaio-<short-id>`) so that
   * concurrent sessions and existing user entries are never overwritten.
   * @param projectDir - Project directory whose `.mcp.json` Claude Code reads.
   * @param env - Spawn environment forwarded into tool execution context.
   */
  private async registerMcpSession(projectDir: string, env: Record<string, string>): Promise<void> {
    const result = await MakaioBus.requestOptional(McpSubjects.session.register, {
      adapterSessionId: this.claudeSessionId,
      agentId: this.agentId,
      adapterId: this.adapterId,
      adapterName: this.adapterName,
      sessionId: this.sessionId ?? this.claudeSessionId,
      pinned: true,
      contextOverrides: {
        cwd: projectDir,
        env,
        sessionId: this.sessionId ?? this.claudeSessionId,
        agentId: this.agentId,
      },
    });

    if (!result.handled) {
      return;
    }

    this.registeredMcpSessionId = this.claudeSessionId;

    // Use a session-scoped name so concurrent sessions and existing user entries
    // in `.mcp.json` are never overwritten by this connector instance.
    const mcpServerName = `makaio-${this.claudeSessionId.slice(0, 8)}`;

    try {
      const installed = await addMcpServerToProject(projectDir, mcpServerName, {
        type: 'http',
        url: `http://127.0.0.1:${result.data.port}/mcp?adapterSessionId=${encodeURIComponent(this.claudeSessionId)}`,
      });
      if (installed) {
        this.installedMcpServerNames.add(mcpServerName);
      }
    } catch (error) {
      await this.unregisterMcpSession();
      throw error;
    }
  }

  /**
   * Remove MCP config entries installed by this connector and unregister the
   * pinned adapter session from the bridge.
   *
   * `unregisterMcpSession()` runs in a `finally` block so the pinned session
   * is always released even when `.mcp.json` removal fails.
   * @param projectDir - Project directory whose `.mcp.json` was updated.
   */
  private async cleanupMcpSession(projectDir: string): Promise<void> {
    const installedNames = [...this.installedMcpServerNames];
    this.installedMcpServerNames.clear();
    const removals = await Promise.allSettled(
      installedNames.map((name) => removeMcpServerFromProject(projectDir, name)),
    );
    await this.unregisterMcpSession();

    const failedRemoval = removals.find((result) => result.status === 'rejected');
    if (failedRemoval?.status === 'rejected') {
      throw failedRemoval.reason;
    }
  }

  /**
   * Unregister the adapter session from the singleton MCP bridge service.
   */
  private async unregisterMcpSession(): Promise<void> {
    if (!this.registeredMcpSessionId) {
      return;
    }
    const adapterSessionId = this.registeredMcpSessionId;
    this.registeredMcpSessionId = undefined;
    await MakaioBus.requestOptional(McpSubjects.session.unregister, {
      adapterSessionId,
    });
  }

  /**
   * Initialize the tmux session, PTY backend, hook subscription, and inner
   * connector session. Resolves when the SessionStart hook has fired.
   *
   * Idempotent: a no-op when a session is already live. Concurrent callers all
   * await the same in-flight promise so only one launch sequence runs.
   * @returns Promise that resolves when the session is ready.
   */
  private initializeSession(): Promise<void> {
    if (this.connectorSession) return Promise.resolve();

    if (!this.initializationPromise) {
      const token = ++this.lifecycleToken;
      this.initializationPromise = this._doInitializeSession(token).catch((error) => {
        // Clear the promise on failure so a future call can retry.
        this.initializationPromise = undefined;
        throw error;
      });
    }

    return this.initializationPromise;
  }

  /**
   * Perform the actual session initialization. Called exactly once per
   * session lifecycle; callers must go through {@link initializeSession}.
   * @param token - Lifecycle token captured when initialization started.
   */
  private async _doInitializeSession(token: number): Promise<void> {
    const env = await this.resolveSpawnEnv();
    const binaryPath = this.config.providerConfig?.binaryPath ?? 'claude';
    const projectDir = this.cwd;
    let earlySessionStartUnsubscribe: (() => void) | undefined;
    let earlySessionStartId: string | undefined;

    try {
      if (!isTmuxAvailable()) {
        throw new Error('Claude Code tmux adapter requires tmux on PATH. Install tmux or use a non-tmux adapter.');
      }

      const mergedEnv = await prepareLaunchPrerequisites({
        projectDir,
        baseEnv: env,
        sessionId: this.claudeSessionId,
        agentId: this.agentId,
        clientProfileName: this.config.clientProfileName,
        ensureHookWiring: (dir, configDir) => this.ensureHookWiring(dir, configDir),
        registerMcpSession: (dir, mcpEnv) => this.registerMcpSession(dir, mcpEnv),
        assertLifecycleCurrent: () => this.assertLifecycleCurrent(token),
      });

      this.backend = new TmuxBackend({ serverName: this.config.providerConfig?.tmuxServerName ?? TMUX_SERVER_NAME });
      earlySessionStartUnsubscribe = subscribeToEarlySessionStart(this.claudeSessionId, (sessionId) => {
        earlySessionStartId = sessionId;
        this.tmuxSession?.observeSessionStart(sessionId);
      });

      const spawnArgs = buildSpawnArgs({
        sessionId: this.claudeSessionId,
        model: this.model,
        systemPrompt: this.systemPrompt,
        skipPermissions: this.config.providerConfig?.skipPermissions,
      });
      const ptyProcess = await this.backend.spawn(binaryPath, spawnArgs, {
        cwd: projectDir,
        env: mergedEnv,
      });
      if (!this.isLifecycleCurrent(token)) {
        ptyProcess.kill();
        throw new Error('Claude Code tmux session initialization was superseded by teardown');
      }

      this.processExitDisposable = ptyProcess.onExit((event) => {
        void this.handleProcessExit(event.exitCode, event.signal);
      });

      this.tmuxSession = new TmuxSession({
        ptyProcess: ptyProcess as ITmuxPtyProcess,
        expectedClaudeSessionId: this.claudeSessionId,
      });
      if (earlySessionStartId !== undefined) {
        this.tmuxSession.observeSessionStart(earlySessionStartId);
      }

      this.hookUnsubscribe = subscribeConnectorHooks(this.tmuxSession, () => this.connectorSession);
      earlySessionStartUnsubscribe();
      earlySessionStartUnsubscribe = undefined;

      // Wait for SessionStart hook to confirm Claude Code is live.
      const sessionStartTimeout = this.getTimeoutMs('initialization');
      await withTimeout(
        this.tmuxSession.waitForSessionStart(),
        sessionStartTimeout,
        'Claude Code SessionStart hook timed out',
      );
      this.assertLifecycleCurrent(token);

      this.userMessageQueue = new UserMessageQueue();
      this.connectorSession = this.createConnectorSession(this.tmuxSession);
      this.wireSessionEvents();
    } catch (error) {
      earlySessionStartUnsubscribe?.();
      await this.teardown({ finalizeActiveTurn: false, cleanupMcp: true });
      throw error;
    }
  }

  /**
   * Create the hook-driven turn session bound to the active tmux session.
   * @param tmuxSession - Live tmux session wrapper.
   * @returns Connector session for queue and turn processing.
   */
  private createConnectorSession(tmuxSession: TmuxSession): TmuxConnectorSession {
    return new TmuxConnectorSession({
      tmuxSession,
      bus: this.config.bus,
      adapterId: this.adapterId,
      adapterName: this.adapterName,
      agentId: this.agentId,
      onTurnStart: (handle) => {
        this.pendingMessageHandle = handle;
      },
      onTurnComplete: (_handle, result) => {
        this.lastResult = result;
        this.pendingMessageHandle = undefined;
      },
      emitTurnCompleted: (payload) => this.emit(ClaudeCodeTmuxConnectorSubjects.turn.turn_completed, payload),
      emitToolUseStarted: (payload) => this.emit(ClaudeCodeTmuxConnectorSubjects.tool_use.started, payload),
      emitToolUseFinished: (payload) => this.emit(ClaudeCodeTmuxConnectorSubjects.tool_use.finished, payload),
      interruptSettleMs: DEFAULT_INTERRUPT_SETTLE_MS,
    });
  }

  /**
   * Wire turn lifecycle bus events to connector processing-state updates.
   *
   * Called once after the tmux session is ready. Subscribes to the adapter's
   * scoped turn subjects so that turn_started / step_started / step_finished /
   * turn_finished events emitted by {@link TmuxConnectorTurn} advance the
   * connector's state machine.
   *
   * The returned unsubscribe functions are stored in {@link sessionEventCleanups}
   * and invoked during {@link teardown} to prevent listener leaks across reconnects.
   */
  private wireSessionEvents(): void {
    if (this.turnEventsWired) return;
    this.turnEventsWired = true;

    this.sessionEventCleanups.push(
      this.on(ClaudeCodeTmuxConnectorSubjects.turn.turn_started, async () => {
        await this.updateProcessingState('turn_started');
      }),
    );

    this.sessionEventCleanups.push(
      this.on(ClaudeCodeTmuxConnectorSubjects.turn.step_started, async () => {
        await this.updateProcessingState('step_started');
      }),
    );

    this.sessionEventCleanups.push(
      this.on(ClaudeCodeTmuxConnectorSubjects.turn.step_finished, async () => {
        await this.updateProcessingState('step_finished');
        await this.processQueue();
      }),
    );

    this.sessionEventCleanups.push(
      this.on(ClaudeCodeTmuxConnectorSubjects.turn.turn_finished, async () => {
        await this.updateProcessingState('turn_finished');
        await this.updateProcessingState('processing_finished');

        const turnStarted = await this.processQueue();
        if (!turnStarted) {
          await this.updateProcessingState('idle');
        }
      }),
    );
  }

  /**
   * Process the message queue via the inner connector session.
   * @returns `true` when a new turn was started, `false` otherwise.
   */
  private async processQueue(): Promise<boolean> {
    if (!this.connectorSession || !this.userMessageQueue) return false;
    return this.connectorSession.processQueue(this.userMessageQueue);
  }

  /**
   * Fail the active turn when the backing Claude Code process exits before a
   * Stop hook completed the turn.
   * @param exitCode - Process exit code from the PTY backend.
   * @param signal - Optional signal from the PTY backend.
   */
  private async handleProcessExit(exitCode: number, signal?: number): Promise<void> {
    const suffix = signal === undefined ? `exit code ${exitCode}` : `exit code ${exitCode}, signal ${signal}`;
    await this.connectorSession?.handleTurnError(
      new Error(`Claude Code process exited before turn completion (${suffix})`),
    );
  }

  // ---------------------------------------------------------------------------
  // AIAgentConnector interface
  // ---------------------------------------------------------------------------

  /**
   * Initialize the session without sending a message.
   *
   * Idempotent — no-op when the session is already live.
   * @param options - Optional start options; captures `systemPrompt` for future use.
   */
  public override async initialize(options?: ConnectorStartOptions): Promise<void> {
    this.captureSystemPrompt(options?.systemPrompt);
    if (this.connectorSession) return;
    await this.initializeSession();
  }

  /**
   * Start the connector with an initial user message.
   * @param message - Normalized first user message.
   * @param options - Optional start options (e.g., delivery mode, message ID).
   * @returns Agent start result with session ID and message handle.
   */
  public override async start(
    message: NormalizedMessageInput,
    options?: ConnectorStartOptions,
  ): Promise<AgentStartResult> {
    this.captureSystemPrompt(options?.systemPrompt);
    const handle = await this.sendMessage(message, options);
    return {
      adapterSessionId: await this.getAdapterSessionId(),
      messageHandle: handle,
      agentId: this.agentId,
    };
  }

  /**
   * Send a user message to the Claude Code session.
   *
   * Enqueues the message, transitions to active if idle, and starts queue
   * processing. Returns the message handle immediately; the turn completes
   * asynchronously via hook events.
   * @param message - Normalized user message.
   * @param options - Optional send options (delivery mode, message ID).
   * @returns The message handle for tracking.
   */
  public override async sendMessage(
    message: NormalizedMessageInput,
    options?: ConnectorSendMessageOptions,
  ): Promise<MessageHandle> {
    if (!this.connectorSession) {
      await this.initializeSession();
    }

    const handle = this.createMessageHandle(message, options);
    this.userMessageQueue!.enqueue(handle);

    const state = this.getProcessingState();
    if (state === 'idle' || state === 'paused') {
      await this.updateProcessingState('active');
      const turnStarted = await this.processQueue();
      if (!turnStarted) {
        await this.updateProcessingState('idle');
      }
    } else if (handle.deliveryMode === 'immediate') {
      await this.processQueue();
    }

    const sessionId = this.adapterSessionId;
    if (sessionId) {
      handle.adapterSessionId = sessionId;
    }

    return handle;
  }

  /**
   * Get the adapter (Claude Code-internal) session ID.
   *
   * Waits for the SessionStart hook when the session is not yet initialized.
   * @returns Promise resolving to the Claude Code session ID.
   * @throws When no session has been started.
   */
  public override async getAdapterSessionId(): Promise<string> {
    return this.claudeSessionId;
  }

  /**
   * Abort the session by killing the tmux pane immediately.
   *
   * Unlike `close()`, this does not wait for graceful shutdown.
   */
  public override abort(): void {
    this.tmuxSession?.kill();
    void this.teardown({
      finalizeActiveTurn: true,
      error: new Error('Claude Code tmux session aborted'),
      cleanupMcp: true,
    }).catch((error: unknown) => {
      console.warn(
        `[ClaudeCodeTmuxConnector] abort cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /**
   * Gracefully close the session.
   *
   * Kills the tmux session and disposes the backend. Unlike `abort()`, this
   * is the normal shutdown path and does not trigger abort-controller errors.
   */
  public override async close(): Promise<void> {
    await this.teardown({
      finalizeActiveTurn: true,
      error: new Error('Claude Code tmux session closed'),
      cleanupMcp: true,
    });
  }

  /**
   * Wait for all messages to finish processing.
   *
   * Mirrors {@link ProceduralAgentConnector.complete} — the base
   * {@link AIAgentConnector} declares this abstract so the override is required.
   * @returns Last message result or `null` if no messages were processed.
   */
  public override async complete(): Promise<MessageResult | null> {
    while (this.getProcessingState() !== 'idle' && this.getProcessingState() !== 'paused') {
      await this.onceProcessingStateChanged();
    }
    return this.lastResult;
  }

  /**
   * Request Claude Code to stop the active turn while keeping the session alive.
   */
  public override async interrupt(): Promise<void> {
    this.tmuxSession?.sendEscape();
  }

  /**
   * Tear down session resources: unsubscribe from turn events, unsubscribe from
   * hooks, dispose the backend, remove MCP bridge state, and drop local handles.
   * @param options - Teardown policy for active turn finalization and MCP cleanup.
   */
  private async teardown(options?: {
    finalizeActiveTurn?: boolean;
    error?: Error;
    cleanupMcp?: boolean;
  }): Promise<void> {
    this.lifecycleToken++;
    if (options?.finalizeActiveTurn) {
      await this.connectorSession?.handleTurnError(options.error ?? new Error('Claude Code tmux session terminated'));
    }

    // Unsubscribe session-event listeners wired by wireSessionEvents().
    for (const cleanup of this.sessionEventCleanups) {
      cleanup();
    }
    this.sessionEventCleanups = [];
    this.turnEventsWired = false;

    // The connector owns hook unsubscription; TmuxSession.dispose() only kills
    // the PTY process and must not call hookUnsubscribe itself (see session.ts).
    this.hookUnsubscribe?.();
    this.hookUnsubscribe = undefined;

    this.processExitDisposable?.dispose();
    this.processExitDisposable = undefined;

    // dispose() kills the PTY process. hookUnsubscribe was already called above.
    this.tmuxSession?.dispose();
    this.tmuxSession = undefined;

    const cleanupTasks = [
      ...(options?.cleanupMcp ? [this.cleanupMcpSession(this.cwd)] : []),
      this.backend?.dispose() ?? Promise.resolve(),
      MakaioBus.requestOptional(ClientSubjects.sessionConfig.destroy, {
        clientId: 'claude-code',
        sessionId: this.claudeSessionId,
      }).catch(() => {}),
    ];
    const cleanupResults = await Promise.allSettled(cleanupTasks);

    this.backend = undefined;
    this.connectorSession = undefined;
    this.userMessageQueue = undefined;
    this.initializationPromise = undefined;
    throwFirstCleanupError(cleanupResults);
  }

  /**
   * Check whether an initialization still owns the connector lifecycle.
   * @param token - Token captured when initialization started.
   * @returns True when no teardown has superseded the initialization.
   */
  private isLifecycleCurrent(token: number): boolean {
    return token === this.lifecycleToken;
  }

  /**
   * Fail if an initialization was superseded by teardown.
   * @param token - Token captured when initialization started.
   */
  private assertLifecycleCurrent(token: number): void {
    if (!this.isLifecycleCurrent(token)) {
      throw new Error('Claude Code tmux session initialization was superseded by teardown');
    }
  }
}

/**
 * Throw the first failed cleanup phase after all independent phases settled.
 * @param results - Settled cleanup task results.
 */
function throwFirstCleanupError(results: PromiseSettledResult<unknown>[]): void {
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') {
    throw failed.reason;
  }
}
