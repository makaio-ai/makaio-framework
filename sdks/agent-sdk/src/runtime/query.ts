/**
 * Runtime-backed `query()` and `startup()` implementations.
 *
 * These functions boot the embedded Makaio runtime on first use and
 * delegate all work to {@link buildQuery} in the shared orchestration layer.
 *
 * `normalizeOptions()` is called before `ensureRuntime()` so that invalid
 * options throw immediately without starting the runtime.
 */

import { normalizeOptions } from '../shared/options.js';
import { registerHooks } from '../shared/hooks.js';
import type { HookConfig } from '../shared/hooks.js';
import type { MakaioQuery, QueryParams, StartupParams } from '../shared/types.js';
import { buildQuery } from '../shared/query-orchestration.js';
import { deferQuery } from '../shared/query-generator.js';
import { ensureRuntime } from './boot.js';

export { buildMcpSessionContext, createSdkMcpServer } from '../shared/mcp.js';

// ---------------------------------------------------------------------------
// query()
// ---------------------------------------------------------------------------

/**
 * Send a prompt to the embedded Makaio runtime and receive an async stream of
 * SDK messages.
 *
 * Boots the embedded runtime on first call.  Subsequent calls reuse the
 * running instance.  Invalid options throw before the runtime is started.
 *
 * The `agent` field uses `kind: 'canonical-model'` so the session
 * orchestrator resolves the canonical model string (e.g. `'sonnet'`,
 * `'anthropic-sdk::sonnet'`) to the appropriate adapter automatically.
 * @param params - Query parameters including prompt and options.
 * @returns A {@link MakaioQuery} async generator.
 */
export function query(params: QueryParams): MakaioQuery {
  const config = normalizeOptions(params.options ?? { model: 'sonnet' });
  return deferQuery(
    (async () => {
      const bus = await ensureRuntime();
      return buildQuery(bus, params, config);
    })(),
  );
}

// ---------------------------------------------------------------------------
// startup()
// ---------------------------------------------------------------------------

/**
 * Eagerly boot the embedded Makaio runtime.
 *
 * Calling this before the first `query()` avoids the cold-start latency on
 * the first query.  It is safe to call multiple times — subsequent calls are
 * no-ops once the runtime is running.
 * @param _params - Optional startup parameters (reserved for future use).
 */
export async function startup(_params?: StartupParams): Promise<void> {
  await ensureRuntime();
}

// ---------------------------------------------------------------------------
// registerRuntimeHooks
// ---------------------------------------------------------------------------

/**
 * Register Claude SDK-compatible hook callbacks against the embedded runtime.
 *
 * Boots the runtime on first call.  Returns a cleanup function that
 * unsubscribes all registered handlers.
 * @param sessionId - Makaio session ID to scope hook events.
 * @param hooks - Hook event name to callback mapping.
 * @returns Cleanup function that removes all subscriptions.
 */
export async function registerRuntimeHooks(sessionId: string, hooks: HookConfig): Promise<() => void> {
  const bus = await ensureRuntime();
  return registerHooks(bus, sessionId, hooks);
}
