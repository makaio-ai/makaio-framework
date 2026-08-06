import { CopilotClient, type SessionConfig } from '@github/copilot-sdk';
import type { SystemPrompt } from '@makaio/contracts';
import type { ClientExecutionContext } from '@makaio/contracts/client';
import type { IMakaioBus } from '@makaio/bus-core';
import type { CopilotSessionEvent, GitHubCopilotConnectorBus } from './namespaces/index.js';
import { fetchToolsForCopilot } from './tool-handling.js';
import { CopilotConnectorSession } from './session.js';
import { mapSystemPromptToSdkConfig } from './session-config.js';
import type { MessageHandle, ISessionToolLedger } from '@makaio/ai-adapters-core';

/**
 * Read-only snapshot of the connector state that session initialization needs.
 *
 * Passed to {@link performSessionInit} so the initialization logic lives outside
 * the connector class without coupling to the full connector instance.
 */
export interface SessionInitContext {
  /** Scoped bus for this connector instance. */
  bus: GitHubCopilotConnectorBus;
  /** Global bus for registry tool loading and execution. */
  globalBus: IMakaioBus;
  /** Adapter instance ID. */
  adapterId: string;
  /** Adapter type name. */
  adapterName: string;
  /** Agent ID for this connector. */
  agentId: string;
  /** Working directory for the spawned CLI process. */
  cwd: string;
  /** Base environment variables for the connector. */
  env: Record<string, string>;
  /** Active model name. */
  model: string;
  /** Default session config (model, tools, reasoningEffort, etc.). */
  defaultSessionConfig: SessionConfig;
  /** Current system prompt, if any. */
  systemPrompt: SystemPrompt | undefined;
  /** Selected token delivered to the Copilot SDK constructor. */
  githubToken: string;
  /** Managed/global binary selected by the central adapter runtime. */
  clientExecution: ClientExecutionContext | undefined;
  /** Optional tool ledger for MCP call tracking. */
  toolLedger?: ISessionToolLedger;
  /** Current turn number supplier for ledger bookkeeping. */
  getCurrentTurnNumber: () => number;
  /** Runtime allowlist for registry tools. Empty array intentionally disables all registry tools. */
  allowedTools?: readonly string[];
  /** Runtime denylist for registry tools. Takes precedence over allowedTools. */
  disallowedTools?: readonly string[];
}

/**
 * Mutable fields written back to the connector after a successful initialization.
 *
 * {@link performSessionInit} returns this object; the connector applies the
 * mutations atomically so it never enters a partially-initialized state.
 */
export interface SessionInitResult {
  /** Confirmed SDK session identifier (may differ from the requested ID). */
  adapterSessionId: string;
  /** Live SDK client for the session. */
  client: CopilotClient;
  /** Initialized connector session ready to accept messages. */
  session: CopilotConnectorSession;
}

/**
 * Callbacks from the connector that the session initialization wires into the
 * new {@link CopilotConnectorSession}.
 */
export interface SessionInitCallbacks {
  /** Forward raw SDK events to the connector's event buffer and bus subject. */
  emitSdkEvent: (event: CopilotSessionEvent) => Promise<void>;
  /** Propagate SDK errors to the connector's error handler. */
  handleError: (error: unknown, terminate: boolean) => void;
  /**
   * Called when a new turn starts; the connector uses this to consume a turn
   * number and set the pending message handle.
   * @param handle - Message handle for the new turn
   */
  onTurnStart: (handle: MessageHandle) => void;
  /**
   * Called when a turn completes; the connector uses this to store the last
   * result and clear the pending message handle.
   * @param handle - Message handle for the completed turn
   * @param result - Turn result with outcome, result, and optional error
   */
  onTurnComplete: (handle: MessageHandle, result: { outcome: string; result?: unknown; error?: unknown }) => void;
  /**
   * Called immediately after the provisional client and session are created,
   * before `session.initialize()` is awaited.
   *
   * The connector uses this to track in-flight resources so that a concurrent
   * `close()` can abort the session and stop the client without waiting for
   * initialization to complete naturally.
   * @param client - Provisional SDK client, not yet fully initialized
   * @param session - Provisional connector session, not yet fully initialized
   */
  onProvisionalResources: (client: CopilotClient, session: CopilotConnectorSession) => void;
}

/** A provisional release that failed while an initialization flight was ending. */
export interface SessionInitializationCleanupFailure {
  /** Resource release stage that did not complete. */
  stage:
    | 'provisional session destroy'
    | 'provisional client stop'
    | 'unpublished session destroy'
    | 'unpublished client stop';
  /** Error returned by the SDK release operation. */
  error: unknown;
}

/**
 * Initialization failure with unaccounted provisional-resource cleanup.
 *
 * The aggregate preserves the original initialization failure and every release
 * failure so terminal close can report unknown evidence rather than masking a
 * failed SDK cleanup as ordinary cancellation.
 */
export class CopilotSessionInitializationCleanupError extends AggregateError {
  /** Initialization or cancellation failure that began cleanup. */
  public readonly initializationError: unknown;
  /** Provisional release stages that rejected. */
  public readonly cleanupFailures: readonly SessionInitializationCleanupFailure[];

  /**
   * Create an aggregate initialization failure.
   * @param initializationError - Failure that caused provisional cleanup
   * @param cleanupFailures - Cleanup stages that rejected while releasing resources
   */
  public constructor(initializationError: unknown, cleanupFailures: readonly SessionInitializationCleanupFailure[]) {
    super(
      [initializationError, ...cleanupFailures.map((failure) => failure.error)],
      'GitHub Copilot session initialization cleanup failed',
    );
    this.name = 'CopilotSessionInitializationCleanupError';
    this.initializationError = initializationError;
    this.cleanupFailures = cleanupFailures;
  }
}

/**
 * Perform a single session initialization flight.
 *
 * Consumes the finalized environment and binary selection, fetches registry tools, creates
 * the {@link CopilotClient} and {@link CopilotConnectorSession}, and initializes
 * the session. On failure, cleans up any provisional
 * resources before re-throwing.
 *
 * The caller owns epoch tracking (single-flight deduplication and
 * invalidation on close). Pass `assertCurrent` to abort the flight if
 * `close()` invalidated the epoch between async steps.
 * @param ctx - Read-only connector state snapshot
 * @param callbacks - Connector-supplied callbacks for events and lifecycle hooks
 * @param assertCurrent - Function that throws if the initialization epoch has
 *   been invalidated by a concurrent `close()` call
 * @returns Initialized session artifacts to be applied to the connector
 */
export async function performSessionInit(
  ctx: SessionInitContext,
  callbacks: SessionInitCallbacks,
  assertCurrent: () => void,
): Promise<SessionInitResult> {
  assertCurrent();

  let client: CopilotClient | undefined;
  let session: CopilotConnectorSession | undefined;

  try {
    // Load registry tools and convert to Copilot SDK format.
    // fetchToolsForCopilot never throws — returns [] when no tools are registered.
    const registryTools = await fetchToolsForCopilot({
      bus: ctx.globalBus,
      adapterId: ctx.adapterId,
      adapterName: ctx.adapterName,
      agentId: ctx.agentId,
      toolLedger: ctx.toolLedger,
      getCurrentTurnNumber: ctx.getCurrentTurnNumber,
      allowedTools: ctx.allowedTools,
      disallowedTools: ctx.disallowedTools,
    });
    assertCurrent();

    // Build final session config with systemMessage and registry tools applied.
    // Important: preserve provider-configured `systemMessage` when no runtime prompt was captured.
    // Registry tools are merged after any tools already present in defaultSessionConfig.
    const systemMessage = mapSystemPromptToSdkConfig(ctx.systemPrompt);
    const sessionConfig: SessionConfig = {
      ...ctx.defaultSessionConfig,
      ...(systemMessage !== undefined ? { systemMessage } : {}),
      tools: [...(ctx.defaultSessionConfig.tools ?? []), ...registryTools],
    };

    client = new CopilotClient({
      cliArgs: ['--disable-builtin-mcps'],
      cwd: ctx.cwd,
      githubToken: ctx.githubToken,
      ...(ctx.clientExecution?.binaryPath ? { cliPath: ctx.clientExecution.binaryPath } : {}),
      // CopilotClient replaces rather than merges process.env. Passing the
      // finalized snapshot even when empty prevents ambient auth inheritance.
      env: ctx.env,
    });

    session = new CopilotConnectorSession({
      bus: ctx.bus,
      adapterId: ctx.adapterId,
      adapterName: ctx.adapterName,
      agentId: ctx.agentId,
      cwd: ctx.cwd,
      model: ctx.model,
      env: ctx.env,
      sessionConfig,
      client,
      emitSdkEvent: callbacks.emitSdkEvent,
      handleError: callbacks.handleError,
      onTurnStart: callbacks.onTurnStart,
      onTurnComplete: callbacks.onTurnComplete,
      toolLedger: ctx.toolLedger,
      getCurrentTurnNumber: ctx.getCurrentTurnNumber,
    });

    // Notify the connector of provisional resources immediately so a concurrent
    // close() can abort/stop them without waiting for initialize() to complete.
    callbacks.onProvisionalResources(client, session);

    // initialize() and getAdapterSessionId() must both succeed before we
    // expose the session. If either throws, subsequent calls will not hit the
    // early-return guard and will retry correctly.
    await session.initialize();
    const adapterSessionId = await session.getAdapterSessionId();
    assertCurrent();

    return { adapterSessionId, client, session };
  } catch (err) {
    const cleanupFailures: SessionInitializationCleanupFailure[] = [];
    try {
      await session?.destroy();
    } catch (error) {
      cleanupFailures.push({ stage: 'provisional session destroy', error });
    }
    try {
      await client?.stop();
    } catch (error) {
      cleanupFailures.push({ stage: 'provisional client stop', error });
    }
    if (cleanupFailures.length > 0) {
      throw new CopilotSessionInitializationCleanupError(err, cleanupFailures);
    }
    throw err;
  }
}
