/**
 * CLI serve composition root.
 *
 * Exports {@link resolveHost} and {@link resolveAuth} as pure helpers so they
 * can be unit-tested independently.  The {@link serve} function wires them
 * together: it creates the HTTP server with a `/health` endpoint, then
 * delegates all service/adapter/plugin wiring to {@link bootMakaioRuntime}.
 * Announces `MAKAIO_PORT=<port>` to stdout for process supervisors.
 */

import type { Server as HttpServer } from 'node:http';
import { Hono } from 'hono';
import { createAdaptorServer } from '@hono/node-server';
import { DispatchingAuth, HmacAuth } from '@makaio/bus-transport-websocket';
import {
  waitForServerListening,
  resolveListeningPort,
  bootMakaioRuntime,
  type MakaioRuntime,
  type CoreBootOptions,
  normalizeNodeHostCapabilities,
  createHonoRouteGraph,
  createHttpRouteGraphBuilder,
} from '@makaio/runtime-node';
import { normalizeBusSecret } from '@makaio/utils';
import { MakaioBus } from '@makaio/bus-core';
import { KernelSubjects } from '@makaio/kernel';
import type { DevPortalMap } from '@makaio/services-package-manager';

/**
 * Host-owned boot overrides forwarded to {@link bootMakaioRuntime}.
 *
 * This keeps the CLI serve composition root reusable for desktop hosts and
 * E2E harnesses without turning discovery policy into end-user CLI flags.
 */
export interface ServeBootOverrides {
  /** Override boot-time discovery strategies. */
  readonly discovery?: CoreBootOptions['discovery'];
  /** Override framework version gating for extensions. */
  readonly frameworkVersion?: CoreBootOptions['frameworkVersion'];
  /** Additional host capability tokens injected into the coordinator. */
  readonly hostCapabilities?: CoreBootOptions['hostCapabilities'];
  /** Host-provided package config defaults. */
  readonly packageConfigDefaults?: CoreBootOptions['packageConfigDefaults'];
  /** Hosted surface category used for extension gating. */
  readonly surface?: CoreBootOptions['surface'];
  /** Host launcher command embedded into client wiring installed from warning actions. */
  readonly launcherCommand?: CoreBootOptions['launcherCommand'];
  /** Optional loopback transport registry name. */
  readonly loopbackName?: CoreBootOptions['loopbackName'];
  /** Workflow runner mode for the workflow engine. Defaults to `piscina`. */
  readonly workflowRunner?: CoreBootOptions['workflowRunner'];
  /**
   * Dev-mode workspace package map forwarded to the package-manager service.
   *
   * When provided and non-empty, extension install specs for known workspace
   * packages are rewritten to Yarn `portal:` ranges pointing at local source
   * directories. Mirrors `frameworkPackagePath` but covers all extension packages.
   */
  readonly devPortalPackages?: DevPortalMap;
  /**
   * Host-provided `@makaio/framework` package root forwarded to boot.
   *
   * In dev mode this is the workspace source directory for
   * `@makaio/framework`. Packaged hosts pass the app-bundled copy here.
   * When omitted, no framework package link is created.
   * @see {@link CoreBootOptions.frameworkPackagePath}
   */
  readonly frameworkPackagePath?: CoreBootOptions['frameworkPackagePath'];
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options for the {@link serve} CLI command.
 */
export interface ServeOptions {
  /**
   * TCP port to bind the bus server on.
   * Defaults to `6252` when omitted.
   */
  port: number;

  /**
   * Bind address override.
   *
   * When omitted the host defaults to `'127.0.0.1'` (loopback only), unless
   * {@link lanBind} is set — in which case it falls back to `'0.0.0.0'`.
   * An explicit value always takes precedence over {@link lanBind}.
   * See {@link resolveHost} for the full resolution rules.
   */
  host?: string;

  /**
   * Bind on all interfaces (`0.0.0.0`) for LAN access.
   *
   * Also enables E2E authentication alongside HMAC — mobile devices can
   * connect using the pairing key exchange protocol once the machine identity
   * is available.
   */
  lanBind?: boolean;

  /**
   * Resolve a peer device's signing public key for E2E relay authentication.
   *
   * Required when {@link lanBind} is `true` — the boot sequence configures the
   * WebSocket transport's E2E auth layer with this callback. Boot fails fast
   * when LAN mode is requested without a resolver.
   * @param peerId - Device ID of the connecting peer.
   * @returns CryptoKey for signature verification, or `null` for unknown or
   *   revoked peers.
   */
  peerSigningKeyResolver?: (peerId: string) => Promise<CryptoKey | null>;

  /**
   * Host-owned boot overrides for discovery policy.
   *
   * Intended for programmatic callers such as desktop hosts and E2E harnesses.
   * The end-user `makaio serve` CLI surface does not expose these as flags.
   */
  boot?: ServeBootOverrides;
}

// ---------------------------------------------------------------------------
// Host resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the bind address from CLI options.
 *
 * An explicit `--host` always wins. When only `--lan-bind` is set (without
 * `--host`), the address defaults to `0.0.0.0` (all interfaces). Otherwise
 * falls back to loopback.
 * @param options - CLI serve options containing host and lanBind fields.
 * @returns Resolved bind address string.
 */
export function resolveHost(options: Pick<ServeOptions, 'host' | 'lanBind'>): string {
  if (options.host !== undefined) return options.host;
  return options.lanBind ? '0.0.0.0' : '127.0.0.1';
}

// ---------------------------------------------------------------------------
// Auth resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the bus auth strategy from the environment.
 *
 * In LAN mode a {@link DispatchingAuth} wraps the optional HMAC strategy so
 * that E2E auth can be hot-swapped in after machine identity is available.
 * In non-LAN mode a bare {@link HmacAuth} is used when the secret is set,
 * or `undefined` for unauthenticated loopback-only mode.
 * @param lanBind - Whether LAN mode is requested.
 * @returns Resolved auth strategy, or `undefined` for dev mode.
 */
export function resolveAuth(lanBind: boolean): DispatchingAuth | HmacAuth | undefined {
  let secret: string | undefined;
  try {
    secret = normalizeBusSecret(process.env['MAKAIO_BUS_SECRET']);
  } catch (error) {
    throw new Error('[serve] MAKAIO_BUS_SECRET is set but empty; refusing to initialize HmacAuth', { cause: error });
  }

  const hmacAuth = secret ? new HmacAuth({ secret }) : undefined;

  if (lanBind) {
    return new DispatchingAuth({ hmac: hmacAuth });
  }

  return hmacAuth;
}

// ---------------------------------------------------------------------------
// Restart handler
// ---------------------------------------------------------------------------

/**
 * Creates a bus handler for `kernel.restart` that schedules a host shutdown.
 *
 * The handler responds with `{ accepted: true }` immediately, then defers the
 * actual shutdown to the next event-loop tick via `schedule` (default:
 * `setTimeout(task, 0)`). This guarantees the RPC response is sent before the
 * process begins teardown.
 * @param options - Handler configuration. `shutdown` is the async function that
 *   performs host shutdown; `schedule` is an optional scheduler for deferred
 *   execution (defaults to `setTimeout(task, 0)`).
 * @returns Bus handler function compatible with `bus.on(KernelSubjects.restart, …)`.
 */
export function createRestartHandler(options: {
  /** Async function that performs host shutdown. */
  shutdown: () => Promise<void> | void;
  /** Optional scheduler for deferred execution (defaults to `setTimeout(task, 0)`). */
  schedule?: (task: () => void) => void;
}) {
  const { shutdown, schedule = (task) => setTimeout(task, 0) } = options;
  let scheduled = false;
  return (ctx: { setResult: (result: { accepted: boolean }) => void }) => {
    ctx.setResult({ accepted: true });
    if (scheduled) return;
    scheduled = true;
    schedule(() => {
      void shutdown();
    });
  };
}

// ---------------------------------------------------------------------------
// Composition root
// ---------------------------------------------------------------------------

/**
 * Start the full Makaio server as a headless process.
 *
 * Creates the HTTP server and Hono app, then delegates to
 * {@link bootMakaioRuntime} for all service/adapter/plugin wiring.
 * Writes `MAKAIO_PORT=<port>` to stdout when ready so process supervisors
 * can capture the actual bound port.
 * @param options - Server startup configuration.
 */
export async function serve(options: ServeOptions): Promise<void> {
  // --- Surface-specific: auth + host resolution ---
  const lanBind = options.lanBind ?? false;
  const host = resolveHost(options);
  const auth = resolveAuth(lanBind);

  // Guard: non-loopback hosts without auth are remotely reachable and
  // unauthenticated. Require MAKAIO_BUS_SECRET or --lan-bind for safety.
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!isLoopback && auth === undefined) {
    throw new Error(
      `[serve] Binding to non-loopback host '${host}' without authentication. ` +
        'Set MAKAIO_BUS_SECRET or use --lan-bind for network-exposed mode.',
    );
  }

  // --- Surface-specific: Hono app + HTTP server ---
  const honoApp = new Hono();
  const routeGraph = createHonoRouteGraph(honoApp, {
    health: () => ({ ok: true, auth: auth !== undefined }),
  });
  const builder = createHttpRouteGraphBuilder(routeGraph);
  const httpServer = createAdaptorServer({ fetch: routeGraph.fetch }) as HttpServer;
  httpServer.listen(options.port, host);
  await waitForServerListening(httpServer, options.port);
  const boundPort = resolveListeningPort(httpServer);
  console.info('[serve] HTTP server listening on port %d', boundPort);

  // --- Shared boot sequence ---
  let runtime!: MakaioRuntime;
  let unsubRestart: (() => void) | undefined;

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = async (): Promise<void> => {
    if (shutdownPromise) {
      return await shutdownPromise;
    }

    shutdownPromise = (async () => {
      unsubRestart?.();
      try {
        await runtime.shutdown();
      } catch (err) {
        console.error('[serve] Error during runtime shutdown:', err);
      } finally {
        await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      }
    })();

    return await shutdownPromise;
  };

  try {
    const bootOverrides = options.boot;
    runtime = await bootMakaioRuntime({
      ...(bootOverrides ?? {}),
      httpServer,
      routeGraphBuilder: builder,
      auth,
      lanBind,
      surface: bootOverrides?.surface ?? 'headless',
      hostCapabilities: normalizeNodeHostCapabilities(bootOverrides?.hostCapabilities),
      peerSigningKeyResolver: options.peerSigningKeyResolver,
      onTransportReady({ host, port: readyPort }) {
        console.info('[serve] Bus transport ready on %s:%d', host, readyPort);
      },
    });
    routeGraph.markReady();
    unsubRestart = MakaioBus.on(KernelSubjects.restart, createRestartHandler({ shutdown }));
    process.stdout.write(`MAKAIO_PORT=${runtime.port}\n`);
  } catch (err) {
    // Boot failed — close the HTTP server we own
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    throw err;
  }

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}
