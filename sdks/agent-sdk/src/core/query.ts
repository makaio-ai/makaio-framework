/**
 * BusClient-backed `query()` and `startup()` implementations for the /core entry point.
 *
 * These functions connect to an existing Makaio runtime over WebSocket on
 * first use and delegate all work to {@link buildQuery} in the shared
 * orchestration layer.
 *
 * `normalizeOptions()` is called before `ensureConnection()` so that invalid
 * options throw without opening a WebSocket connection.
 */

import { normalizeOptions } from '../shared/options.js';
import { registerHooks } from '../shared/hooks.js';
import type { HookConfig } from '../shared/hooks.js';
import type { MakaioQuery, QueryParams, StartupParams } from '../shared/types.js';
import { buildQuery } from '../shared/query-orchestration.js';
import { deferQuery } from '../shared/query-generator.js';
import { ensureConnection } from './connection.js';
import type { ConnectionOptions } from './connection.js';

export { buildMcpSessionContext, createSdkMcpServer } from '../shared/mcp.js';

// ---------------------------------------------------------------------------
// query()
// ---------------------------------------------------------------------------

/**
 * Send a prompt to a running Makaio runtime over WebSocket and receive an
 * async stream of SDK messages.
 *
 * Connects to the runtime on first call.  Subsequent calls reuse the cached
 * connection.  Invalid options throw before a connection is opened.
 *
 * The `websocketUrl` option selects the target runtime — omit to use
 * `MAKAIO_BUS_URL` or the default `ws://127.0.0.1:6252/bus`.
 *
 * The `agent` field uses `kind: 'canonical-model'` so the session
 * orchestrator resolves the canonical model string (e.g. `'sonnet'`,
 * `'anthropic-sdk::sonnet'`) to the appropriate adapter automatically.
 * @param params - Query parameters including prompt and options.
 * @returns A {@link MakaioQuery} async generator.
 */
export function query(params: QueryParams): MakaioQuery {
  const config = normalizeOptions(params.options ?? { model: 'sonnet' });
  const connectionOptions: ConnectionOptions = {
    websocketUrl: config.websocketUrl,
    websocketAuth: config.websocketAuth,
  };
  return deferQuery(
    (async () => {
      const bus = await ensureConnection(connectionOptions);
      return buildQuery(bus, params, config);
    })(),
  );
}

// ---------------------------------------------------------------------------
// startup()
// ---------------------------------------------------------------------------

/**
 * Eagerly connect to the Makaio runtime over WebSocket.
 *
 * Calling this before the first `query()` avoids the cold-start latency on
 * the first query.  It is safe to call multiple times — subsequent calls are
 * no-ops once the connection is established.
 * @param params - Optional startup parameters containing WebSocket connection overrides.
 */
export async function startup(params?: StartupParams): Promise<void> {
  await ensureConnection({
    websocketUrl: params?.options?.websocketUrl,
    websocketAuth: params?.options?.websocketAuth,
  });
}

// ---------------------------------------------------------------------------
// registerCoreHooks
// ---------------------------------------------------------------------------

/**
 * Register Claude SDK-compatible hook callbacks against a running Makaio runtime.
 *
 * Connects to the runtime on first call.  Returns a cleanup function that
 * unsubscribes all registered handlers.
 * @param sessionId - Makaio session ID to scope hook events.
 * @param hooks - Hook event name to callback mapping.
 * @param options - Optional connection overrides (URL, auth).
 * @returns Cleanup function that removes all subscriptions.
 */
export async function registerCoreHooks(
  sessionId: string,
  hooks: HookConfig,
  options?: ConnectionOptions,
): Promise<() => void> {
  const bus = await ensureConnection(options);
  return registerHooks(bus, sessionId, hooks);
}
