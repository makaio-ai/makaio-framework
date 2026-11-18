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
import { describeTransportEnd, notifyObserver, type IJsonlTransport, type TransportEnd } from '@makaio/subprocess';
import type { InitializeParams } from '../protocol/generated/index.js';
import { createJsonRpcClient as makeJsonRpcClient, type JsonRpcClient } from '../utils/jsonRpcClient.js';
import { APP_SERVER_PROCESS_NAME, createStdioTransport } from '../utils/createStdioTransport.js';
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
  getInjectedTransport: () => IJsonlTransport | undefined;
  /** Returns the transport currently owned (and closeable) by this connector. */
  getOwnedTransport: () => IJsonlTransport | undefined;
  /** Replaces (or clears) the owned transport reference. */
  setOwnedTransport: (transport: IJsonlTransport | undefined) => void;
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
   * Runs the connector's local finalisation after the end of its current
   * generation that it requested itself.
   *
   * The transport keeps such an end off its error channel, so this is the only
   * path left that can complete a turn the shutdown interrupted.
   * @param end - The generation's end report, with cause `requested`
   */
  finalizeRequestedShutdown: (end: TransportEnd) => void;
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
export function connectorTransport(ctx: ConnectionManagerContext): IJsonlTransport | undefined {
  return ctx.getOwnedTransport() ?? ctx.getInjectedTransport();
}

/**
 * Ask for the end of the app-server connection a connector holds: close its
 * JSON-RPC client, then the transport itself.
 *
 * The connector, not the client, answers for the process behind its transport,
 * and its close waits for that process's end. A client closes only a transport
 * it was built on, and there may be no such client: it is created on the first
 * connection, so a close before that has none, and an injected client is not
 * built on an injected transport at all. Requesting the end here, whatever the
 * client did, keeps the close from waiting for an end nobody asked for. The
 * request is idempotent, so one a client already made is not repeated, and it
 * is made even when the client's close throws.
 * @param ctx - Connection manager context
 * @throws Whatever the client's close throws, after the transport's end was requested.
 */
export function requestEnd(ctx: ConnectionManagerContext): void {
  try {
    ctx.getJsonRpcClient()?.close();
  } finally {
    void connectorTransport(ctx)?.close();
  }
}

/**
 * Create and attach the JSON-RPC client to the connector.
 *
 * If the context already has a client (from a test injection or a prior call),
 * only registers handlers and returns immediately. Otherwise, consumes the
 * centrally finalized environment and binary selection, spawns the subprocess as
 * a new generation, and creates the client on it.
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

  // An injected transport is the connector's one and only generation: it stands
  // for a process the connector did not spawn and cannot replace. Its end is
  // supervised once, by the connector that holds it, and the client built on it
  // owns it like any other channel: when `resetClient` closes that client after
  // a failed handshake, the transport ends, and its requested end terminates the
  // connector through `superviseGenerationEnd`. A failed handshake on an
  // injected transport is therefore terminal; only a spawned generation can be
  // reset and replaced.
  const injectedTransport = ctx.getInjectedTransport();
  if (injectedTransport !== undefined) {
    ctx.setJsonRpcClient(makeJsonRpcClient(injectedTransport));
  } else {
    spawnGeneration(ctx);
  }
  ctx.registerClientHandlers();
}

/**
 * Spawn one app-server generation, own it, create its client, and evaluate its end.
 *
 * The client subscribes to the generation's end report before the evaluation
 * does. Both react to the same report, in subscription order: the client first
 * settles every request still outstanding with that end, and only then can a
 * terminal error abort the connector and close the client — which would
 * otherwise reject those requests as merely closed and hide why they failed.
 * @param ctx - Connection manager context
 */
function spawnGeneration(ctx: ConnectionManagerContext): void {
  const transport = createStdioTransport({
    cwd: ctx.cwd,
    env: ctx.env,
    binaryPath: ctx.clientExecution?.binaryPath ?? undefined,
  });
  ctx.setOwnedTransport(transport);
  ctx.setJsonRpcClient(makeJsonRpcClient(transport));
  superviseGenerationEnd(ctx, transport);
}

/**
 * Evaluate the end of one app-server generation, exactly once.
 *
 * The transport reports its end once, with a cause derived from the order of what
 * it observed — the stop intent, the exit, a failed channel. A close issued while
 * an unexpected end is being delivered (the JSON-RPC client closes its transport
 * on that very end) therefore cannot turn it into a requested one, and there is
 * no second evaluation left to finalise it twice.
 *
 * **Bound to the generation, and through it to the turn.** Only a generation that
 * still answers for the connector ({@link connectorTransport}) finalises anything:
 * the connector runs every turn on its current generation, so the turn pending at
 * its end is that generation's turn. A requested end finalises that turn locally;
 * an unexpected end or a failed spawn is a terminal connector error. A generation
 * that {@link resetClient} superseded never completed its handshake — a reset
 * replaces only such generations, and turns start after the handshake — so it
 * never ran a turn, and its end must not reach the generation that replaced it or
 * that generation's turn: it finalises nothing. Above all it never terminates the
 * connector — terminating on a reset generation's end is what once made a failed
 * handshake unrecoverable, because the retry reconnected without the API-key login
 * the termination discarded. Its exit evidence still reaches the connector,
 * through the retirement ledger.
 *
 * Called by the spawn of every owned generation, after its client subscribed,
 * and, once, by the connector for an injected transport, before any client
 * exists: there a terminal error rejects outstanding requests as closed.
 * @param ctx - Connection manager context
 * @param transport - Transport of the generation whose end is evaluated
 */
export function superviseGenerationEnd(ctx: ConnectionManagerContext, transport: IJsonlTransport): void {
  void transport.ended.then((end) => {
    if (connectorTransport(ctx) !== transport) return;
    // `handleError` reaches the connector's own observers; the continuation is
    // discarded, so a throw must not become an unhandled rejection.
    notifyObserver(
      () => {
        if (end.cause === 'requested') {
          ctx.finalizeRequestedShutdown(end);
          return;
        }
        ctx.handleError(new Error(`${APP_SERVER_PROCESS_NAME} ${describeTransportEnd(end)}`), true);
      },
      (error) => console.error('[CodexAppServerConnector] generation end handler threw', error),
    );
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
 * the dropped transport's own exit observation (`exitObserved`, which fulfils on
 * an observed exit only, never on a give-up) is awaited, bounded by the exit
 * budget, before the reset returns. An end that does not arrive in that window
 * does **not** fail the reset: a stuck predecessor must not block a live agent, so
 * the non-observation is recorded instead and caps every class this connector
 * reports until the ledger, which keeps watching, observes that end.
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
        // Bounded and never rejecting; the end is consumed below and by the
        // generation's own evaluation.
        void transport.close();
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
    await ctx.generations.retire(ctx.generations.supersede(transport.exitObserved));
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
