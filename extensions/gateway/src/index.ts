/**
 * Public entry point for the gateway extension.
 *
 * Exports the executable extension manifest consumed by `ExtensionCoordinator`
 * at boot, along with the full public config and contracts surface.
 *
 * Routing types (`RouteTarget`, `RouteDecision`, etc.) are package-internal and
 * are not part of the public API.
 * @packageDocumentation
 */

import type { MakaioNodeExtension } from '@makaio/contracts/extension';
import type { IMakaioBus } from '@makaio/bus-core';
import type { Hono } from 'hono';
import { GatewayService } from './gateway-service.js';
import { parseGatewayConfig, GatewayConfigSchema } from './config.js';
import { GatewayNamespace } from './contracts/namespace.js';

/** Module-level service instance populated by `create` and used by `http.mount`. */
let service: GatewayService | null = null;

/**
 * Check whether the host app exposes the Hono `route` method needed by this
 * extension.
 * @param app - Host-owned app value received by `http.mount`.
 * @returns Whether the value satisfies the `route(prefix, app)` contract.
 */
function isHonoRouteTarget(app: unknown): app is Pick<Hono, 'route'> {
  return typeof app === 'object' && app !== null && typeof (app as { readonly route?: unknown }).route === 'function';
}

/**
 * Executable extension manifest for the LLM Gateway.
 *
 * Routes Claude Code traffic per request model to a named upstream (Anthropic
 * or LiteLLM). Mount via `ANTHROPIC_BASE_URL=http://127.0.0.1:6252/gateway`
 * in the Claude Code environment.
 *
 * `surface` is matched exactly against the surface the host runtime declares
 * itself to be (`'headless'` for the CLI server, `'interactive'` for the
 * desktop hosts), so `'any'` is the only value that loads the gateway in both;
 * a concrete value would silently exclude every host that is not that value.
 */
export const gatewayExtension: MakaioNodeExtension<IMakaioBus> = {
  name: 'gateway',
  displayName: 'LLM Gateway',
  version: '0.1.0',
  surface: 'any',
  configSchema: GatewayConfigSchema,
  namespaces: [GatewayNamespace],

  /**
   * Parse the stored extension config and construct the gateway service.
   * @param ctx - Runtime extension context supplying the bus, raw config, the
   *   shutdown signal, and the optional host-supplied credential resolver.
   * @returns The constructed (but not yet initialised) `GatewayService`.
   */
  create(ctx) {
    const config = parseGatewayConfig(ctx.config);
    service = new GatewayService(ctx.bus, config, ctx.signal, ctx.credentials);
    return service;
  },

  http: {
    prefix: '/gateway',

    /**
     * Mount the gateway Hono sub-app on the host application.
     *
     * Called by the host after `init()` completes and re-called on every
     * route-graph rebuild. Idempotence holds because the host passes a fresh
     * Hono app instance on each rebuild, so `app.route('/gateway', …)` always
     * registers against a clean router rather than accumulating duplicate routes.
     * @param app - Host-owned Hono application (typed `unknown` by contracts).
     */
    mount(app: unknown): void {
      if (!service) {
        console.debug('[gateway] Skipping HTTP mount — service not available.');
        return;
      }
      if (!isHonoRouteTarget(app)) {
        throw new TypeError('gateway extension requires a Hono-compatible host app with a route() method.');
      }
      app.route('/gateway', service.router);
    },
  },
};

export default gatewayExtension;

// ── Config ──────────────────────────────────────────────────────────────────
export {
  AnthropicUpstreamSchema,
  GatewayConfigSchema,
  GatewayRuleSchema,
  LitellmUpstreamSchema,
  ReasoningModeSchema,
  StrategySchema,
  parseGatewayConfig,
} from './config.js';
export type {
  AnthropicUpstreamConfig,
  GatewayConfig,
  GatewayRule,
  LitellmUpstreamConfig,
  ReasoningMode,
  StrategyConfig,
  UpstreamConfig,
} from './config.js';

// ── Logging ─────────────────────────────────────────────────────────────────
export type { GatewayLogger } from './logging.js';

// ── Contracts ────────────────────────────────────────────────────────────────
export {
  GatewayNamespace,
  GatewaySchemas,
  GatewaySubjects,
  RequestOutcomeSchema,
  RequestRoutedEventSchema,
} from './contracts/index.js';
export type { RequestOutcome, RequestRoutedEvent } from './contracts/index.js';
