import { CopilotClient, type SessionConfig } from '@github/copilot-sdk';
import { resolveSessionEnvironment, type SessionEnvironmentOptions } from '@makaio/ai-adapters-core/config';
import type { SystemPrompt } from '@makaio/contracts';
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
  /**
   * Provider context for credential resolution.
   * Forwarded verbatim to {@link resolveSessionEnvironment}.
   */
  providerContext: SessionEnvironmentOptions['providerContext'];
  /** Optional tool ledger for MCP call tracking. */
  toolLedger?: ISessionToolLedger;
  /** Current turn number supplier for ledger bookkeeping. */
  getCurrentTurnNumber: () => number;
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

/**
 * Perform a single session initialization flight.
 *
 * Resolves credentials and the binary path, fetches registry tools, creates
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
  // Resolve credentials, credential env, and binary before creating the SDK
  // client/session so that a missing token throws fast outside the try block.
  const { credentials, credEnv, resolvedBinary, spawnEnv } = await resolveSessionEnvironment({
    bus: ctx.bus,
    providerContext: ctx.providerContext,
    clientId: 'github-copilot',
    baseEnv: ctx.env,
  });
  // credEnv carries COPILOT_TOKEN when the provider maps the credential field to
  // that env var name.  When providerContext is absent (host supplies the token
  // directly via config.env / process.env) credEnv is empty but spawnEnv already
  // merges baseEnv (this.env), so spawnEnv['COPILOT_TOKEN'] covers that path.
  const githubToken = credEnv['COPILOT_TOKEN'] ?? credentials['token'] ?? spawnEnv['COPILOT_TOKEN'];

  if (!githubToken) {
    throw new Error('GitHub Copilot token not provided. Configure credentials via provider settings.');
  }
  assertCurrent();

  let client: CopilotClient | undefined;
  let session: CopilotConnectorSession | undefined;

  try {
    // Load registry tools and convert to Copilot SDK format.
    // fetchToolsForCopilot never throws — returns [] when no tools are registered.
    const registryTools = await fetchToolsForCopilot({
      adapterId: ctx.adapterId,
      adapterName: ctx.adapterName,
      agentId: ctx.agentId,
      toolLedger: ctx.toolLedger,
      getCurrentTurnNumber: ctx.getCurrentTurnNumber,
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

    // The CopilotClient `env` option replaces process.env entirely for the
    // spawned subprocess. `spawnEnv` is already the merged result of the
    // connector's base env, credential env vars, and binary isolation env
    // (in that order, with binary env taking final precedence). Only pass it
    // when it carries anything beyond the empty base so the subprocess
    // inherits process.env in the common framework-only case.
    const hasSpawnEnv = Object.keys(spawnEnv).length > 0;

    client = new CopilotClient({
      cliArgs: ['--disable-builtin-mcps'],
      cwd: ctx.cwd,
      githubToken,
      ...(resolvedBinary?.binaryPath ? { cliPath: resolvedBinary.binaryPath } : {}),
      ...(hasSpawnEnv ? { env: spawnEnv } : {}),
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
    // Best-effort cleanup of provisional resources.
    await session?.destroy().catch(() => undefined);
    await client?.stop().catch(() => undefined);
    throw err;
  }
}
