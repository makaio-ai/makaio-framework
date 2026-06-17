import { isKnownSdkMessageForRouting, type SDKMessage } from '@makaio/client-claude-code';
import { McpSubjects, type McpTransportConfig } from '@makaio/contracts';
import { MakaioBus } from '@makaio/bus-core';
import {
  BaseConnectorSession,
  markCompletedWithFinalResult,
  type AIReasoningLevel,
  type MessageHandle,
  type MessageResult,
  type UserMessageQueue,
  processQueueMessages,
} from '@makaio/ai-adapters-core';
import { buildTextPrompt, extractMessageText } from '@makaio/ai-adapters-claude-process-shared';
import { DeferredPromise } from '@makaio/utils';
import type { CliStdioTransport } from './utils/createStdioTransport.js';
import { createStdioTransport } from './utils/createStdioTransport.js';
import { buildCliArgs } from './utils/buildCliArgs.js';
import { ClaudeConnectorTurn, type IQueryInterruptable } from './turn.js';
import { ClaudeCodeCliConnectorSubjects } from './namespace/index.js';
import type {
  ClaudeCliSessionConfig,
  ClaudeCliTurnExecutionContext,
  EmitSdkEventCallback,
  OnTurnCompleteCallback,
  OnTurnStartCallback,
} from './types.js';

/**
 * No-op interruptable adapter for the CLI transport.
 *
 * The `claude -p` process is single-shot — once spawned, it cannot be
 * interrupted mid-stream the same way the SDK's `query.interrupt()` works.
 * Killing the process is handled at the session level (`abort()`/`close()`).
 * This satisfies the `IQueryInterruptable` seam required by ClaudeConnectorTurn.
 */
class CliInterruptable implements IQueryInterruptable {
  private readonly transport: CliStdioTransport;

  /**
   * Create an interrupt bridge for a CLI stdio transport.
   * @param transport - Active CLI transport used to terminate the current subprocess on interrupt.
   */
  public constructor(transport: CliStdioTransport) {
    this.transport = transport;
  }

  /**
   * Interrupt by killing the subprocess.
   * @returns Promise that resolves immediately after kill signal is sent
   */
  public async interrupt(): Promise<void> {
    this.transport.close();
  }
}

interface TurnSessionIdentity {
  resumeId: string | undefined;
  sessionIdForMcp: string;
}

type ResultMessageWithStructuredOutput = Extract<SDKMessage, { type: 'result' }> & {
  result?: string;
  structured_output?: unknown;
};

/**
 * Session for the Claude Code CLI adapter.
 *
 * Manages the lifecycle of spawned `claude` CLI processes:
 * - Spawns a new process for each turn (CLI is single-shot with `-p`)
 * - Parses JSONL stdout into SDK messages and emits to the connector
 * - Tracks confirmed session ID from the `system.init` event
 * - Supports resume by passing `--resume <sessionId>` on subsequent turns
 *
 * Multi-turn design:
 * Each `startTurn()` call spawns a fresh `claude -p --resume <sessionId>` process.
 * The CLI resumes the conversation server-side using the session ID persisted by
 * the previous invocation. This matches the `--session-id`/`--resume` flags.
 */
export class ClaudeCliSession extends BaseConnectorSession<ClaudeCliSessionConfig> {
  private transport?: CliStdioTransport;
  protected declare currentTurn?: ClaudeConnectorTurn;
  private deferredSessionId = new DeferredPromise<string>();
  private confirmedSessionId = false;
  /** Adapter session ID currently registered with the MCP bridge service, if any */
  private registeredMcpSessionId?: string;
  /** Emitter callback provided by the connector for metadata injection */
  private readonly emitSdkEvent?: EmitSdkEventCallback;
  /** Callbacks for turn lifecycle notifications */
  private readonly onTurnStart?: OnTurnStartCallback;
  private readonly onTurnComplete?: OnTurnCompleteCallback;

  /**
   * Resolve resume/session IDs for the next CLI turn.
   * @param mergedContent - Optional merged content from immediate-mode supersede
   * @returns Session identity values for turn startup
   */
  private resolveTurnSessionIdentity(mergedContent?: string[]): TurnSessionIdentity {
    const isImmediateRestart = mergedContent !== undefined && mergedContent.length > 0;
    if (isImmediateRestart) {
      this.resetForImmediateRestart();
    }

    const resumeId = isImmediateRestart
      ? undefined
      : this.confirmedSessionId
        ? this.sessionId
        : this.config.resumeAdapterSessionId;
    return {
      resumeId,
      sessionIdForMcp: resumeId ?? this.sessionId!,
    };
  }

  /**
   * Build the upstream MCP server entries from resolved session context.
   *
   * Each entry maps directly from {@link McpResolvedServer} transport config to the
   * Claude Code CLI `--mcp-config` JSON format. Upstream servers are placed before
   * the Makaio entry so Makaio tooling always wins on name collision.
   *
   * Duplicate/reserved names are handled by the 3-tier merge precedence in
   * buildMcpServersRecord (configMcpServers → upstream → makaio). The makaio
   * entry always wins, so an upstream server named "makaio" is silently
   * overridden rather than causing an error. This is intentional — fail-fast
   * here would prevent session creation for a configuration issue that the
   * merge already handles safely.
   * @returns Record keyed by server name with transport config values
   */
  private buildUpstreamMcpEntries(): Record<string, McpTransportConfig> {
    const entries: Record<string, McpTransportConfig> = {};
    for (const server of this.config.mcpUpstreamServers ?? []) {
      entries[server.name] = server.transport;
    }
    return entries;
  }

  /**
   * Register the adapter session with the singleton MCP bridge service via bus RPC
   * and produce the CLI `--mcp-config` payload.
   *
   * Uses `requestOptional` for graceful degradation: when the bridge service is not
   * running, upstream servers are still provided if available.
   * @param sessionIdForMcp - Adapter session ID to route MCP approvals for this turn
   * @param env - Fresh subprocess environment for this turn
   * @returns Config with serialized JSON and bridge availability flag, or `undefined`
   *   when neither the bridge nor upstream servers are available
   */
  private async registerMcpContextAndBuildConfig(
    sessionIdForMcp: string,
    env: Record<string, string>,
  ): Promise<{ config: string; hasBridge: boolean } | undefined> {
    // MakaioBus (global singleton) is intentional here — MCP subjects live in
    // the `mcp` namespace, which is unreachable from the adapter's scoped bus.
    // Same pattern used by ToolSubjects.execute and AgentSubjects throughout
    // the adapter layer for all cross-namespace RPCs.
    const result = await MakaioBus.requestOptional(McpSubjects.session.register, {
      adapterSessionId: sessionIdForMcp,
      agentId: this.config.agentId,
      adapterId: this.config.adapterId,
      adapterName: this.config.adapterName,
      // Makaio session ID routes approval requests to the owning browser tab.
      // Falls back to the adapter session ID when not running within a UI session.
      sessionId: this.config.makaioSessionId ?? sessionIdForMcp,
      contextOverrides: {
        cwd: this.config.cwd,
        env,
        sessionId: this.config.makaioSessionId ?? sessionIdForMcp,
        agentId: this.config.agentId,
        adapterSessionId: sessionIdForMcp,
      },
    });

    const upstreamEntries = this.buildUpstreamMcpEntries();

    if (!result.handled) {
      // Bridge unavailable — still provide upstream servers if any.
      if (Object.keys(upstreamEntries).length === 0) return undefined;
      return { config: JSON.stringify({ mcpServers: upstreamEntries }), hasBridge: false };
    }

    this.registeredMcpSessionId = sessionIdForMcp;
    const { port } = result.data;

    return {
      config: JSON.stringify({
        mcpServers: {
          // Upstream servers first; Makaio entry wins on any name collision.
          ...upstreamEntries,
          makaio: {
            type: 'http',
            url: `http://127.0.0.1:${port}/mcp?adapterSessionId=${encodeURIComponent(sessionIdForMcp)}`,
          },
        },
      }),
      hasBridge: true,
    };
  }

  /**
   * Unregister the adapter session from the singleton MCP bridge service.
   *
   * Best-effort: fire-and-forget via `requestOptional`. If the bridge service
   * is not available or the unregister fails, the stale mapping will be
   * cleaned up by the bridge service's own session expiry logic.
   */
  private unregisterMcpSession(): void {
    if (!this.registeredMcpSessionId) {
      return;
    }
    const sessionId = this.registeredMcpSessionId;
    this.registeredMcpSessionId = undefined;
    void MakaioBus.requestOptional(McpSubjects.session.unregister, {
      adapterSessionId: sessionId,
    }).catch(() => {
      // Best-effort cleanup — ignore bridge failures during teardown.
    });
  }

  /**
   * Reset session identity for immediate-mode restart after superseding a live subprocess.
   */
  private resetForImmediateRestart(): void {
    // Drop stale MCP routing entry for the superseded subprocess/session.
    this.unregisterMcpSession();
    this.confirmedSessionId = false;
    this.sessionId = globalThis.crypto.randomUUID();
    this.deferredSessionId = new DeferredPromise<string>();
    this.deferredSessionId.resolve(this.sessionId);
  }

  /**
   * Create a CLI session and pre-resolve its provisional adapter session ID.
   * @param config - Session configuration including optional callbacks (`emitSdkEvent`, `onTurnStart`,
   * `onTurnComplete`) and optional `predeterminedSessionId` for swap/recovery paths.
   */
  public constructor(config: ClaudeCliSessionConfig) {
    super(config);
    this.emitSdkEvent = config.emitSdkEvent;
    this.onTurnStart = config.onTurnStart;
    this.onTurnComplete = config.onTurnComplete;
    // Keep local session identity aligned with resume when available to ensure
    // MCP approval routing and adapter metadata use the same adapterSessionId.
    this.sessionId = config.predeterminedSessionId ?? config.resumeAdapterSessionId ?? globalThis.crypto.randomUUID();
    this.deferredSessionId.resolve(this.sessionId);
  }

  /**
   * Initialize the session — pre-resolves the session ID from config or generates one.
   * No subprocess is spawned until the first turn starts.
   */
  public async initialize(): Promise<void> {
    // No-op: subprocess is spawned per-turn in startTurn()
  }

  /**
   * Update the reasoning effort level that will be passed to the next CLI spawn.
   *
   * The CLI is stateless per-turn, so `--effort` is injected fresh on every
   * `startTurn`. Calling this method before the next turn ensures the updated
   * level takes effect without requiring a session teardown and recreation.
   * @param level - New reasoning effort level, or `undefined` to clear it
   */
  public setReasoningEffort(level: AIReasoningLevel | undefined): void {
    this.config.reasoningEffort = level;
  }

  /**
   * Process messages from the queue.
   *
   * Delegates to the shared `processQueueMessages` orchestration which handles
   * immediate-mode superseding, late rejection, and normal enqueue processing.
   *
   * Returns `true` when a new turn was started, `false` when no action was taken
   * (e.g., all immediate messages were rejected). Callers use this to decide
   * whether to transition to idle.
   * @param queue - User message queue to process
   * @returns True if a new turn was started
   */
  public async processQueue(queue: UserMessageQueue): Promise<boolean> {
    return processQueueMessages(queue, {
      getCurrentTurn: () => this.currentTurn,
      extractContent: (handle) => extractMessageText(handle.message),
      startNewTurn: (handle, mergedContent) => this.startTurn(handle, mergedContent),
    });
  }

  /**
   * Start a new turn by spawning a `claude -p` process for the given message.
   *
   * Each turn is a separate CLI invocation. For turns after the first, the
   * `--resume` flag is passed so the CLI restores the conversation context.
   * @param handle - Message handle to process
   * @param mergedContent - Optional content from superseded/merged messages (for immediate mode)
   */
  public async startTurn(handle: MessageHandle, mergedContent?: string[]): Promise<void> {
    // Notify connector that turn is starting
    this.onTurnStart?.(handle);

    const prompt = buildTextPrompt(handle, mergedContent);
    const { resumeId, sessionIdForMcp } = this.resolveTurnSessionIdentity(mergedContent);
    const executionContext = await this.resolveAndPersistTurnExecutionContext();
    const mcpResult = await this.registerMcpContextAndBuildConfig(sessionIdForMcp, executionContext.env);
    const mcpConfig = mcpResult?.config;
    const permissionPromptTool = mcpResult?.hasBridge ? 'mcp__makaio__approve' : undefined;

    const args = buildCliArgs({
      config: {
        ...this.config,
        resumeAdapterSessionId: resumeId,
        responseSchema: handle.responseSchema,
      },
      prompt,
      sessionId: this.sessionId!,
      mcpConfig,
      permissionPromptTool,
    });

    const transport = createStdioTransport(
      args,
      this.config.cwd,
      executionContext.env,
      executionContext.binaryPath,
      this.config.firstOutputTimeoutMs,
    );
    this.transport = transport;

    const interruptable = new CliInterruptable(transport);

    this.currentTurn = new ClaudeConnectorTurn(
      this.bus,
      ClaudeCodeCliConnectorSubjects,
      this.config.adapterId,
      this.config.adapterName,
      this.config.agentId,
      interruptable,
      handle,
    );
    const turnForThisTransport = this.currentTurn;

    transport.onError((error) => {
      // Ignore if a newer subprocess has replaced this transport
      if (this.transport !== transport) return;
      void this.completeTransportError(turnForThisTransport, handle, error);
    });

    transport.onMessage((msg) => {
      // Ignore if a newer subprocess has replaced this transport
      if (this.transport !== transport) return;
      void this.handleSdkMessage(msg, handle).catch((error) => {
        console.error('[Session] Failed to handle SDK message:', error);
      });
    });

    await this.currentTurn.start();
  }

  /**
   * Resolve and persist the execution context for the next CLI turn.
   * @returns Environment and binary path for the next subprocess
   */
  private async resolveAndPersistTurnExecutionContext(): Promise<ClaudeCliTurnExecutionContext> {
    const context = this.config.resolveTurnExecutionContext
      ? await this.config.resolveTurnExecutionContext()
      : { env: this.config.env, binaryPath: this.config.binaryPath };
    this.config.env = context.env;
    this.config.binaryPath = context.binaryPath;
    return context;
  }

  /**
   * Handle an SDK message from the JSONL stream.
   *
   * Extracts the session ID from `system.init`, emits the event through the
   * connector callback, then advances the turn state machine.
   * @param msg - Parsed JSONL message from CLI stdout
   * @param handle - Active message handle for this turn
   */
  private async handleSdkMessage(msg: unknown, handle: MessageHandle): Promise<void> {
    // Guard against stale messages from a killed subprocess.
    // After an immediate-mode supersede, the old transport may flush buffered
    // messages after `this.currentTurn` has been replaced.
    if (this.currentTurn && this.currentTurn.getMessageHandle() !== handle) {
      return;
    }

    // Emit every SDK payload so lenient bus validation can report protocol drift.
    // Emission is diagnostic only; it must not block routing of system.init or
    // result payloads that drive the session state machine.
    if (this.emitSdkEvent) {
      void this.emitSdkEvent(msg).catch((error: unknown) => {
        console.error('[ClaudeCliSession] Failed to emit SDK event', error);
      });
    } else {
      void this.bus.emit(ClaudeCodeCliConnectorSubjects.sdk.event, msg as SDKMessage).catch((error: unknown) => {
        console.error('[ClaudeCliSession] Failed to emit SDK event', error);
      });
    }
    if (!isKnownSdkMessageForRouting(msg)) return;
    const sdkMessage = msg;

    // Extract confirmed session ID from system.init
    if (sdkMessage.type === 'system' && sdkMessage.subtype === 'init') {
      if (!this.confirmedSessionId) {
        this.confirmedSessionId = true;
        this.sessionId = sdkMessage.session_id;
        // Re-resolve with the confirmed ID (replace the preliminary promise)
        this.deferredSessionId = new DeferredPromise<string>();
        this.deferredSessionId.resolve(sdkMessage.session_id);
      }
      // Acknowledge the handle: the subprocess received the prompt and started processing.
      // This mirrors the SDK adapter's isReplay acknowledgment and allows immediate-mode
      // callers to enqueue follow-up messages while the turn is still in-flight.
      handle.markAcknowledged();
    }

    // Handle result message — complete the turn
    if (sdkMessage.type === 'result' && this.currentTurn) {
      const isSuccess = sdkMessage.subtype === 'success' && !sdkMessage.is_error;
      const result: MessageResult = isSuccess
        ? {
            outcome: 'completed',
            result: {
              message: this.resolveResultMessage(sdkMessage),
            },
          }
        : {
            outcome: 'error',
            error: new Error(sdkMessage.subtype ?? 'Unknown CLI error'),
          };

      await markCompletedWithFinalResult(handle, result, this.onTurnComplete);
    }

    // Advance turn state machine
    if (this.currentTurn) {
      await this.currentTurn.handleSdkEvent(sdkMessage);
    }
  }

  /**
   * Complete a transport-level error turn after canonical handle transforms.
   * @param turn - Turn attached to the failed transport
   * @param handle - Message handle for the failed turn
   * @param error - Transport error
   */
  private async completeTransportError(turn: ClaudeConnectorTurn, handle: MessageHandle, error: Error): Promise<void> {
    // Once provider result handling has started, that path owns terminal turn finalization.
    // Late transport errors from the same subprocess must not re-enter completion while
    // result callbacks are still draining.
    if (handle.isProcessed) return;

    const result: MessageResult = { outcome: 'error', error };
    await markCompletedWithFinalResult(handle, result, this.onTurnComplete);
    try {
      await turn.finishOnError();
    } catch (finishError) {
      console.error('[Session] Failed to finish errored turn:', finishError);
    }
  }

  /**
   * Resolve the terminal message from a successful CLI result.
   *
   * When `--json-schema` is active, Claude Code CLI returns the typed value in
   * `structured_output`. Makaio's terminal message contract is still text, so
   * the structured value is serialized back to JSON for shared validation and
   * persistence.
   * @param msg - Successful CLI result message.
   * @returns Terminal message text for the Makaio message result.
   */
  private resolveResultMessage(msg: ResultMessageWithStructuredOutput): string {
    if ('structured_output' in msg && msg.structured_output !== undefined) {
      return JSON.stringify(msg.structured_output);
    }
    return msg.result ?? '';
  }

  /**
   * Get the adapter session ID.
   * Waits for `system.init` to confirm the ID if not yet received.
   * @returns Promise resolving to the confirmed or preliminary session ID
   */
  public override async getAdapterSessionId(): Promise<string> {
    if (this.confirmedSessionId) return this.sessionId!;
    return this.deferredSessionId.getPromise();
  }

  /**
   * Abort the session by killing the active subprocess.
   * Also unregisters agent context from the MCP context registry if registered.
   */
  public override async abort(): Promise<void> {
    await this.close();
    await super.abort();
  }

  /**
   * Gracefully close the session (kills the subprocess if active).
   * Unregisters agent context from the MCP context registry if registered.
   */
  public async close(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined;
    try {
      transport?.close();
    } catch (error) {
      console.error('[Session] Failed to close transport during close', error);
    }
    this.unregisterMcpSession();
  }
}
