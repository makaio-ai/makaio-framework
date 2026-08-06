/**
 * Connection lifecycle management for the Codex App-Server connector.
 *
 * Handles JSON-RPC client creation, subprocess spawning, the Codex `initialize`
 * and normalized account-login handshake, and error-path teardown. The connector holds all
 * mutable state; this module mutates it only through the typed accessors in
 * {@link ConnectionManagerContext}.
 * @packageDocumentation
 */

import { resolveDisabledNativeTools, type GenerationRetirementLedger } from '@makaio/ai-adapters-core';
import type { IMakaioBus } from '@makaio/bus-core';
import type { ClientExecutionContext } from '@makaio/contracts/client';
import type { InitializeParams } from '../protocol/generated/index.js';
import { createJsonRpcClient as makeJsonRpcClient, type JsonRpcClient } from '../utils/jsonRpcClient.js';
import { createStdioTransport, type StdioTransport } from '../utils/createStdioTransport.js';
import { CLIENT_INFO } from './types.js';
import { loginCodexApiKeyAccount, type CodexApiKeyAccountLogin } from './account-login.js';

/** Stable, credential-free process-reset failure categories. */
export type CodexConnectionResetErrorReason = 'client-close-failed' | 'transport-close-failed';

/** Process-reset failure that never retains a transport or protocol error payload. */
export class CodexConnectionResetError extends Error {
  /**
   * @param reason - Stable reset stage safe for diagnostics
   */
  public constructor(public readonly reason: CodexConnectionResetErrorReason) {
    super(
      reason === 'client-close-failed'
        ? 'Codex app-server client reset failed.'
        : 'Codex app-server transport reset failed.',
    );
    this.name = 'CodexConnectionResetError';
  }
}

/**
 * Mutable connector state and callbacks required by the connection manager.
 *
 * All state accessors are passed as getters/setters so the manager never holds
 * a stale reference to the connector's internal fields.
 */
export interface ConnectionManagerContext {
  /** Returns the current JSON-RPC client, or `undefined` before first connection. */
  getJsonRpcClient: () => JsonRpcClient | undefined;
  /** Replaces the active JSON-RPC client (or clears it by passing `undefined`). */
  setJsonRpcClient: (client: JsonRpcClient | undefined) => void;
  /** Returns the injected test-double client, if any. */
  getInjectedJsonRpcClient: () => JsonRpcClient | undefined;
  /** Returns the injected test-double transport, if any. */
  getInjectedTransport: () => StdioTransport | undefined;
  /** Returns the transport currently owned (and closeable) by this connector. */
  getOwnedTransport: () => StdioTransport | undefined;
  /** Replaces (or clears) the owned transport reference. */
  setOwnedTransport: (transport: StdioTransport | undefined) => void;
  /** Returns the current `isConnected` flag. */
  getIsConnected: () => boolean;
  /** Updates the `isConnected` flag. */
  setIsConnected: (value: boolean) => void;
  /** Updates the `clientHandlersRegistered` flag to `false` on reset. */
  setClientHandlersRegistered: (value: boolean) => void;
  /** Clears the `disabledNativeTools` set to an empty set on reset. */
  setDisabledNativeTools: (tools: ReadonlySet<string>) => void;
  /** Working directory passed to the subprocess on first spawn. */
  cwd: string;
  /** Subprocess environment finalized by the central adapter runtime. */
  env: Record<string, string>;
  /** Adapter type name used for harness tool policy lookup. */
  adapterName: string;
  /** Optional client identity used for harness tool policy lookup. */
  clientId: string | undefined;
  /** Managed binary selection finalized by the central adapter runtime. */
  clientExecution: ClientExecutionContext | undefined;
  /** Private API-key protocol delivery retained for reconnecting this connector. */
  getAccountLogin: () => CodexApiKeyAccountLogin | undefined;
  /** Optional harness ID for native-tool policy lookup. */
  harnessId: string | undefined;
  /** Global bus used for cross-namespace harness policy lookup. */
  globalBus: IMakaioBus;
  /**
   * The connector's record of app-server process generations it superseded
   * without watching them end (I33).
   *
   * Held by the connector rather than by this module so one ledger spans every
   * reset and the connector's own close, which is what lets a class reported at
   * close time still carry a predecessor nobody watched.
   */
  generations: GenerationRetirementLedger;
  /**
   * Registers JSON-RPC notification and server-request handlers on the newly created client.
   * Called immediately after the client is assigned so handlers are in place before any
   * messages are sent.
   */
  registerClientHandlers: () => void;
  /**
   * Routes transport or protocol errors through the connector's error handling path.
   * @param error - The error to handle
   * @param terminate - When `true`, the connector should be torn down
   */
  handleError: (error: unknown, terminate: boolean) => void;

  /**
   * Runs the connector's local finalisation after an exit it requested itself.
   *
   * The error channel deliberately stays silent for such an exit, so this is
   * the only path left that can complete a turn the shutdown interrupted.
   * @param code - Exit code reported by the child, or `null` for a signalled exit
   * @param terminate - Whether the connector itself is ending, rather than one of
   *   its process generations being replaced
   */
  finalizeRequestedShutdown: (code: number | null, terminate: boolean) => void;
}

/**
 * The transport whose child answers for this connector right now.
 *
 * One definition for a question two places ask — the class a close reports, and
 * whose shutdown an observed exit belongs to — because answering it differently
 * in the two is exactly how a reset generation gets mistaken for the connector's
 * own end. Ownership decides who may close a transport; this decides whose end
 * shows.
 * @param ctx - Connection manager context
 * @returns The owned transport, the injected one, or `undefined` when neither exists
 */
export function connectorTransport(ctx: ConnectionManagerContext): StdioTransport | undefined {
  return ctx.getOwnedTransport() ?? ctx.getInjectedTransport();
}

/**
 * Create and attach the JSON-RPC client to the connector.
 *
 * If the context already has a client (from a test injection or a prior call),
 * only registers handlers and returns immediately. Otherwise, consumes the
 * centrally finalized environment and binary selection, spawns the subprocess, and
 * registers the error callback.
 * @param ctx - Connection manager context
 */
async function createClient(ctx: ConnectionManagerContext): Promise<void> {
  if (ctx.getJsonRpcClient()) {
    ctx.registerClientHandlers();
    return;
  }

  const injected = ctx.getInjectedJsonRpcClient();
  if (injected) {
    ctx.setJsonRpcClient(injected);
    ctx.registerClientHandlers();
    return;
  }

  const transport =
    ctx.getInjectedTransport() ?? createStdioTransport(ctx.cwd, ctx.env, ctx.clientExecution?.binaryPath ?? undefined);
  if (!ctx.getInjectedTransport()) {
    ctx.setOwnedTransport(transport);
  }
  ctx.setJsonRpcClient(makeJsonRpcClient(transport));
  transport.onError((error) => ctx.handleError(error, true));
  wireRequestedShutdownFinalisation(ctx, transport);
  ctx.registerClientHandlers();
}

/**
 * Route an exit the connector asked for into local finalisation only.
 *
 * Exit evidence and turn finalisation are separate concerns. A close this
 * connector requested must not surface as a terminal connector error — the
 * transport withholds it from the error channel for exactly that reason — but
 * the turn that was in flight across the shutdown still has to be completed,
 * or its caller waits on a handle nobody will ever settle. So the exit is
 * consumed here instead, and only for the requested case: an unexpected death
 * already travelled through `onError` and must not be finalised twice.
 *
 * **Requested by whom is the second question, and it decides termination.** A
 * transport shutdown marker says "somebody in this runtime asked for this exit",
 * and two very different parties can be that somebody: a `close`/`abort` of the
 * *connector*, or a {@link resetClient} dropping one app-server generation after
 * a failed handshake. Terminating on the second is what made a failed handshake
 * unrecoverable — the retry reconnected without the API-key login the termination
 * discarded, and the later close reported a repeat teardown instead of closing
 * the process that retry had spawned. So termination is gated on the exiting
 * transport still being {@link connectorTransport}: a generation the reset
 * released is no longer it, and its end finalises the interrupted turn without
 * ending the connector that outlived it.
 *
 * Exported for the suite that drives this seam directly: the wiring happens
 * inside subprocess creation, which a unit test cannot reach without spawning a
 * real `codex` binary.
 * @param ctx - Connection manager context
 * @param transport - Transport whose child exit is being observed
 */
export function wireRequestedShutdownFinalisation(ctx: ConnectionManagerContext, transport: StdioTransport): void {
  void transport.exited.then((code) => {
    if (!transport.shutdownRequested()) return;
    ctx.finalizeRequestedShutdown(code, connectorTransport(ctx) === transport);
  });
}

/**
 * Tear down the active JSON-RPC client and owned transport after a connection failure.
 *
 * Resets connection and handler-registration flags so the next `initializeConnection`
 * call starts fresh. If an injected test client is present it is restored (not closed)
 * so the test can continue using the same mock instance.
 *
 * **This is the connector's generation-retirement choke point (I33).** Every
 * app-server process this connector replaces inside itself is dropped here, and a
 * replacement may not start before its predecessor's end has been consumed — so
 * the dropped transport's own exit observation is awaited, bounded by the exit
 * budget, before the reset returns. An end that does not arrive in that window
 * does **not** fail the reset: a stuck predecessor must not block a live agent, so
 * the non-observation is recorded instead and caps every class this connector
 * reports afterwards.
 * @param ctx - Connection manager context
 */
export async function resetClient(ctx: ConnectionManagerContext): Promise<void> {
  ctx.setIsConnected(false);
  ctx.setClientHandlersRegistered(false);
  ctx.setDisabledNativeTools(new Set());

  const transport = ctx.getOwnedTransport();
  ctx.setOwnedTransport(undefined);

  const injected = ctx.getInjectedJsonRpcClient();
  if (injected) {
    ctx.setJsonRpcClient(injected);
    return;
  }

  const client = ctx.getJsonRpcClient();
  const failures: CodexConnectionResetError[] = [];
  try {
    if (client !== undefined) {
      try {
        client.close();
      } catch {
        failures.push(new CodexConnectionResetError('client-close-failed'));
      }
    }
    if (transport !== undefined && (client === undefined || failures.length > 0)) {
      try {
        transport.close();
      } catch {
        failures.push(new CodexConnectionResetError('transport-close-failed'));
      }
    }
  } finally {
    ctx.setJsonRpcClient(undefined);
  }

  // Booked before the failures are raised: a reset that could not close cleanly
  // is exactly the case where the predecessor is most likely still alive, and it
  // is the one where losing the record would matter most.
  if (transport !== undefined) {
    await ctx.generations.retire(ctx.generations.supersede(transport.exited));
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Codex connection reset encountered multiple failures.');
  }
}

/**
 * Perform the full Codex process-ready handshake in a single flight.
 *
 * Spawns the subprocess (or reuses an injected client), resolves disabled native
 * tools via the global harness bus, sends `initialize`/`initialized`, and applies
 * the selected API-key login before publishing the connection as ready.
 * On any error the client is torn down via {@link resetClient} before re-throwing
 * so the next call starts from a clean state.
 * @param ctx - Connection manager context
 */
async function performConnectionInit(ctx: ConnectionManagerContext): Promise<void> {
  try {
    await createClient(ctx);

    // Harness lookups remain global-bus scoped because harness subjects live
    // in the global namespace.
    ctx.setDisabledNativeTools(
      new Set(await resolveDisabledNativeTools(ctx.globalBus, ctx.adapterName, ctx.harnessId, ctx.clientId)),
    );

    // Superset of generated InitializeParams — adds experimentalApi capability for item/tool/call.
    const initParams: InitializeParams & { capabilities?: Record<string, unknown> } = {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true },
    };
    const client = ctx.getJsonRpcClient();
    if (!client) throw new Error('JSON-RPC client not initialized');
    await client.request('initialize', initParams);
    client.notification('initialized', {});
    const accountLogin = ctx.getAccountLogin();
    if (accountLogin !== undefined) {
      await loginCodexApiKeyAccount(client, accountLogin);
    }
    ctx.setIsConnected(true);
  } catch (error) {
    try {
      await resetClient(ctx);
    } catch (resetError) {
      throw new AggregateError([error, resetError], 'Codex process-ready handshake and reset both failed.', {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Ensure the connector is connected, using single-flight deduplication.
 *
 * Concurrent callers share the same in-flight promise so the subprocess is spawned
 * exactly once. Resolves immediately when already connected.
 * @param ctx - Connection manager context
 * @param inflight - Mutable holder for the in-flight promise; updated by this function
 * @returns Promise that resolves when the connection is established
 */
export function initializeConnection(
  ctx: ConnectionManagerContext,
  inflight: { promise: Promise<void> | undefined },
): Promise<void> {
  if (ctx.getIsConnected()) return Promise.resolve();
  inflight.promise ??= performConnectionInit(ctx).finally(() => {
    inflight.promise = undefined;
  });
  return inflight.promise;
}
