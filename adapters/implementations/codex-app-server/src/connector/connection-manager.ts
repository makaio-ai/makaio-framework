/**
 * Connection lifecycle management for the Codex App-Server connector.
 *
 * Handles JSON-RPC client creation, subprocess spawning, credential resolution,
 * the ACP `initialize` handshake, and error-path teardown. The connector holds all
 * mutable state; this module mutates it only through the typed accessors in
 * {@link ConnectionManagerContext}.
 * @packageDocumentation
 */

import { MakaioBus } from '@makaio/bus-core';
import { resolveDisabledNativeTools } from '@makaio/ai-adapters-core';
import type { ProviderContext } from '@makaio/contracts';
import type { InitializeParams } from '../protocol/generated/index.js';
import { createJsonRpcClient as makeJsonRpcClient, type JsonRpcClient } from '../utils/jsonRpcClient.js';
import { createStdioTransport, type StdioTransport } from '../utils/createStdioTransport.js';
import { resolveSessionEnvironment, type SessionEnvironmentOptions } from '@makaio/ai-adapters-core/config';
import { CLIENT_INFO } from './types.js';

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
  /** Environment variables merged into the subprocess environment. */
  env: Record<string, string>;
  /** Adapter type name used for harness tool policy lookup. */
  adapterName: string;
  /** Provider context carrying credential refs for resolution. */
  providerContext: ProviderContext | undefined;
  /** Optional client identifier for binary resolution (defaults to `'codex'`). */
  clientId: string | undefined;
  /** Optional harness ID for native-tool policy lookup. */
  harnessId: string | undefined;
  /** Scoped bus used for credential resolution. */
  bus: SessionEnvironmentOptions['bus'];
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
}

/**
 * Create and attach the JSON-RPC client to the connector.
 *
 * If the context already has a client (from a test injection or a prior call),
 * only registers handlers and returns immediately. Otherwise, resolves credentials
 * and the managed binary path, spawns the subprocess via stdio transport, and
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

  const { resolvedBinary, spawnEnv } = await resolveSessionEnvironment({
    bus: ctx.bus,
    providerContext: ctx.providerContext,
    clientId: ctx.clientId ?? 'codex',
    baseEnv: ctx.env,
  });

  const transport =
    ctx.getInjectedTransport() ?? createStdioTransport(ctx.cwd, spawnEnv, resolvedBinary?.binaryPath ?? undefined);
  if (!ctx.getInjectedTransport()) {
    ctx.setOwnedTransport(transport);
  }
  ctx.setJsonRpcClient(makeJsonRpcClient(transport));
  transport.onError((error) => ctx.handleError(error, true));
  ctx.registerClientHandlers();
}

/**
 * Tear down the active JSON-RPC client and owned transport after a connection failure.
 *
 * Resets connection and handler-registration flags so the next `initializeConnection`
 * call starts fresh. If an injected test client is present it is restored (not closed)
 * so the test can continue using the same mock instance.
 * @param ctx - Connection manager context
 */
export function resetClient(ctx: ConnectionManagerContext): void {
  ctx.setIsConnected(false);
  ctx.setClientHandlersRegistered(false);
  ctx.setDisabledNativeTools(new Set());

  const transport = ctx.getOwnedTransport();
  ctx.setOwnedTransport(undefined);

  const injected = ctx.getInjectedJsonRpcClient();
  if (!injected) {
    ctx.getJsonRpcClient()?.close();
    if (!ctx.getJsonRpcClient() && transport) {
      transport.close();
    }
    ctx.setJsonRpcClient(undefined);
    return;
  }

  ctx.setJsonRpcClient(injected);
}

/**
 * Perform the full ACP `initialize` handshake in a single flight.
 *
 * Spawns the subprocess (or reuses an injected client), resolves disabled native
 * tools via the global harness bus, sends `initialize`, and fires `initialized`.
 * On any error the client is torn down via {@link resetClient} before re-throwing
 * so the next call starts from a clean state.
 * @param ctx - Connection manager context
 */
async function performConnectionInit(ctx: ConnectionManagerContext): Promise<void> {
  try {
    await createClient(ctx);

    // Harness lookups remain global-bus scoped: harness subjects live in the
    // global namespace, while credential refs resolve through the connector bus.
    ctx.setDisabledNativeTools(
      new Set(await resolveDisabledNativeTools(MakaioBus, ctx.adapterName, ctx.harnessId, ctx.clientId)),
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
    ctx.setIsConnected(true);
  } catch (error) {
    resetClient(ctx);
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
