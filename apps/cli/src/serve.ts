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
import {
  DispatchingAuth,
  HmacAuth,
  registerMakaioLocalCliHmacIdentity,
  resolveHmacIdentityPeer,
  resolveHmacIdentitySecret,
} from '@makaio/bus-transport-websocket';
import {
  waitForServerListening,
  resolveListeningPort,
  bootMakaioRuntime,
  type MakaioRuntime,
  type CoreBootOptions,
  normalizeNodeHostCapabilities,
  createHonoRouteGraph,
  createHttpRouteGraphBuilder,
  type HonoRouteGraph,
  type HttpRouteGraphBuilder,
  installHostShutdown,
  type HostShutdownOptions,
  type HostStopSignal,
  LOCAL_STEP_STOP_BUDGET_MS,
  resourceStepStopBudgetMs,
} from '@makaio/runtime-node';
import { normalizeBusSecret, outerBoundMs } from '@makaio/utils';
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
  /** Base workflow runner mode for the workflow engine. Defaults to Piscina. */
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
 * What a `serve` host does on a terminal hangup (`SIGHUP`).
 *
 * - `'shutdown'`: the hangup runs the same shutdown as `SIGINT` and `SIGTERM`
 *   (persistent, joined by later signals, every step bounded by a window of its own), so
 *   the detached extension children, which run in process groups of their own
 *   and receive no terminal signal, are stopped with the host.
 * - `'ignore'`: the host installs a listener that does nothing but log the
 *   first hangup, and keeps running and serving. Ignoring needs a real
 *   listener: `nohup` alone does not protect a Node host, because Node resets
 *   an inherited ignored `SIGHUP` at startup, and libraries loaded into the
 *   host (`signal-exit`, via `proper-lockfile`, `execa` and `ink`) install a
 *   `SIGHUP` listener that re-raises the signal when it is the only one.
 */
export type HangupPolicy = 'shutdown' | 'ignore';

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
   * What the host does on a terminal hangup (`SIGHUP`). Defaults to
   * `'shutdown'`; `serve --ignore-hangup` selects `'ignore'`. See {@link HangupPolicy}.
   */
  hangup?: HangupPolicy;

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
  return createAuth(lanBind, resolveConfiguredBusSecret());
}

/**
 * Normalize the optional shared bus secret from the process environment.
 * @returns Normalized secret, or `undefined` when authentication is disabled.
 */
function resolveConfiguredBusSecret(): string | undefined {
  try {
    return normalizeBusSecret(process.env['MAKAIO_BUS_SECRET']);
  } catch (error) {
    throw new Error('[serve] MAKAIO_BUS_SECRET is set but empty; refusing to initialize HmacAuth', { cause: error });
  }
}

/**
 * Create server authentication from a normalized optional bus secret.
 * @param lanBind - Whether LAN mode is requested.
 * @param secret - Normalized shared bus secret.
 * @returns Auth strategy for the server transport.
 */
function createAuth(lanBind: boolean, secret: string | undefined): DispatchingAuth | HmacAuth | undefined {
  const hmacAuth = secret
    ? new HmacAuth({ secret, resolveSecret: resolveHmacIdentitySecret, resolvePeer: resolveHmacIdentityPeer })
    : undefined;

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
  const busSecret = resolveConfiguredBusSecret();
  const auth = createAuth(lanBind, busSecret);
  const unregisterLocalCliIdentity =
    busSecret === undefined ? undefined : registerMakaioLocalCliHmacIdentity(busSecret);

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

  await bootUnderHostShutdown(options, {
    httpServer,
    routeGraph,
    builder,
    auth,
    lanBind,
    unregisterLocalCliIdentity,
  });
}

/** Signals every serve host stops on, whatever its hangup policy. */
const STOP_SIGNALS: readonly HostStopSignal[] = ['SIGINT', 'SIGTERM'];

/**
 * Split the process signals into the ones the host stops on and the ones it survives.
 * @param hangup - Hangup policy; defaults to `'shutdown'`.
 * @returns The `signals` and `ignoredSignals` of the host shutdown.
 */
function signalPolicy(hangup: HangupPolicy = 'shutdown'): Pick<HostShutdownOptions, 'signals' | 'ignoredSignals'> {
  return hangup === 'ignore'
    ? { signals: STOP_SIGNALS, ignoredSignals: ['SIGHUP'] }
    : { signals: [...STOP_SIGNALS, 'SIGHUP'], ignoredSignals: [] };
}

/**
 * What {@link serve} has built by the time the runtime boots, and what the
 * shutdown therefore has to release.
 */
interface ServeHostResources {
  /** HTTP server, already listening; closed by the shutdown. */
  readonly httpServer: HttpServer;
  /** Route graph marked ready once the runtime is up. */
  readonly routeGraph: HonoRouteGraph;
  /** Route graph builder handed to the boot. */
  readonly builder: HttpRouteGraphBuilder;
  /** Bus authentication strategy. */
  readonly auth: DispatchingAuth | HmacAuth | undefined;
  /** Whether LAN mode is requested. */
  readonly lanBind: boolean;
  /** Releases the local CLI identity; `undefined` when none was registered. */
  readonly unregisterLocalCliIdentity: (() => void) | undefined;
}

/**
 * Boot the runtime with the process signals already owned by the host
 * shutdown, then announce the port.
 *
 * Detached extension children run in process groups of their own, so a
 * terminal signal reaches the host only; the runtime's shutdown stops the
 * children. The handlers are installed before the boot can start a child, and
 * stay installed until the teardown has finished, so a later signal joins the
 * shutdown in progress instead of ending the host in the middle of it. A signal
 * during the boot cancels it through the boot's own rollback.
 * @param options - Server startup configuration.
 * @param resources - What {@link serve} built and the shutdown releases.
 */
async function bootUnderHostShutdown(options: ServeOptions, resources: ServeHostResources): Promise<void> {
  const { httpServer, routeGraph, builder, auth, lanBind, unregisterLocalCliIdentity } = resources;
  let unsubRestart: (() => void) | undefined;
  // The booted runtime, or `undefined` while the boot runs and once it failed
  // or was cancelled (it has rolled itself back by then). Not yet known while
  // the shutdown is installed, which is why the steps read it through here.
  let runtime: MakaioRuntime | undefined;
  let bootOutcome: Promise<void> = Promise.resolve();
  // The boot's own bound on how long cancelling it takes, reported by the boot
  // as soon as it starts and read when the host's boot step begins.
  let bootCancellationBudgetMs: (() => number) | undefined;

  // Each step has a window of its own. The runtime's is the bound it reports
  // for its own teardown, whose stages enforce their windows themselves, plus a
  // margin: the host's timer is a backstop for a runtime that does not hold to
  // its bound, never the thing that limits it (`outerBoundMs`).
  const hostShutdown = installHostShutdown({
    label: 'serve',
    ...signalPolicy(options.hangup),
    steps: [
      { name: 'restart handler', budgetMs: () => LOCAL_STEP_STOP_BUDGET_MS, run: () => unsubRestart?.() },
      // A boot a signal interrupted rolls itself back once the phase in flight
      // reaches a checkpoint. It reports how long that takes, so a phase that
      // never reaches one still ends the host with the step named.
      {
        name: 'runtime boot',
        budgetMs: () => (bootCancellationBudgetMs === undefined ? undefined : outerBoundMs(bootCancellationBudgetMs())),
        run: () => bootOutcome,
      },
      {
        name: 'runtime shutdown',
        budgetMs: () => (runtime === undefined ? undefined : outerBoundMs(runtime.stopBudgetMs())),
        run: () => runtime?.shutdown(),
      },
      {
        name: 'HTTP server close',
        budgetMs: resourceStepStopBudgetMs,
        run: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
      },
      {
        name: 'local CLI identity',
        budgetMs: () => LOCAL_STEP_STOP_BUDGET_MS,
        run: () => unregisterLocalCliIdentity?.(),
      },
    ],
  });
  const bootOverrides = options.boot;
  const bootAttempt = bootMakaioRuntime({
    ...(bootOverrides ?? {}),
    httpServer,
    routeGraphBuilder: builder,
    auth,
    lanBind,
    surface: bootOverrides?.surface ?? 'headless',
    hostCapabilities: normalizeNodeHostCapabilities(bootOverrides?.hostCapabilities),
    peerSigningKeyResolver: options.peerSigningKeyResolver,
    signal: hostShutdown.cancellation,
    onCancellationBudget: (stopBudgetMs) => {
      bootCancellationBudgetMs = stopBudgetMs;
    },
    onTransportReady({ host, port: readyPort }) {
      console.info('[serve] Bus transport ready on %s:%d', host, readyPort);
    },
  });
  bootOutcome = bootAttempt.then(
    (booted) => {
      runtime = booted;
    },
    () => undefined,
  );

  let booted: MakaioRuntime;
  try {
    booted = await bootAttempt;
  } catch (err) {
    // The shutdown owns the cleanup of the HTTP server and the identity, so a
    // failed boot goes through it too: its signal listeners and its step
    // windows stay in force until that cleanup has finished.
    const interrupted = hostShutdown.cancellation.aborted;
    await (interrupted ? hostShutdown.finished() : hostShutdown.request('boot failure'));
    // A boot a signal cancelled is a clean exit, unless its rollback failed
    // (then `err` is an AggregateError and the cancellation reason is its cause).
    if (interrupted && err === hostShutdown.cancellation.reason) return;
    throw err;
  }

  if (hostShutdown.cancellation.aborted) {
    // The boot completed before it could see the request; the shutdown tears the finished runtime down.
    await hostShutdown.finished();
    return;
  }
  routeGraph.markReady();
  unsubRestart = MakaioBus.on(
    KernelSubjects.restart,
    createRestartHandler({ shutdown: () => hostShutdown.request('kernel.restart') }),
  );
  process.stdout.write(`MAKAIO_PORT=${booted.port}\n`);
}
