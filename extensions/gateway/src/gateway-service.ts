/**
 * `GatewayService` — lifecycle owner for the gateway extension.
 *
 * Builds the Hono sub-application that the extension manifest's `http.mount`
 * callback mounts, and owns the credentials that application forwards with:
 * one per upstream that needs it (Anthropic upstreams with `auth.apiKey` and
 * all LiteLLM upstreams) plus the gateway's own `accessToken` when configured.
 *
 * **Credentials resolve lazily, not during `init()`.** Extension services start
 * in discovery order, and a `stored:` reference can only be resolved once the
 * service that owns the credential store has started — which may be after this
 * one. Resolving eagerly would therefore fail activation for a configuration
 * that is entirely correct, and nothing would retry it. Instead the router is
 * built immediately and handed a memo: it resolves on first use, is kept only
 * on success, and is discarded on failure so the next request tries again. The
 * coordinator-ready barrier kicks that memo once, which is when a genuinely
 * broken reference is reported to the operator.
 *
 * **Security invariant:** All resolved credential plaintexts are held only in
 * memory for the lifetime of the service, inside the memoised runtime. They are
 * never logged, emitted on the bus, or stored to disk.
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import type { CredentialResolver } from '@makaio/contracts';
import type { CredentialRef } from '@makaio/contracts/config';
import { KernelSubjects } from '@makaio/kernel/namespace';
import { BaseService } from '@makaio/service-base';
import type { Hono } from 'hono';
import type { GatewayConfig } from './config.js';
import { GatewaySubjects } from './contracts/index.js';
import { logCredentialFailure, resolveGatewayLogger, type GatewayLogger } from './logging.js';
import { compileRules } from './routing/match.js';
import { createGatewayRouter, type GatewayRuntime } from './routes.js';

/**
 * One upstream name paired with the credential reference that must be resolved
 * for that upstream before the routing table can be compiled.
 */
interface UpstreamCredentialRequest {
  /** Name of the upstream as declared in the `upstreams` config map. */
  readonly upstreamName: string;
  /** Branded credential reference string to resolve. */
  readonly ref: CredentialRef;
}

/**
 * Compute the set of upstream names that are actually reachable at runtime.
 *
 * An upstream is referenced when it is named by `default` or appears in the
 * `to` list of at least one routing rule. Upstreams absent from this set are
 * unreachable — their credentials must not be resolved so an unresolvable
 * secret on an unused upstream does not block initialisation.
 * @param config - Validated gateway configuration.
 * @returns Set of referenced upstream names.
 */
function collectReferencedUpstreamNames(config: GatewayConfig): Set<string> {
  const names = new Set<string>();
  names.add(config.default);
  for (const rule of config.rules) {
    for (const name of rule.to) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Collect (upstreamName, ref) pairs that need credential resolution.
 *
 * Only upstreams reachable at runtime (the `default` and every `to` entry
 * across all rules) are included. An unreferenced upstream with an
 * unresolvable secret does not block initialisation.
 *
 * Emits one entry per referenced upstream that requires a secret:
 * - Anthropic upstreams with `auth.apiKey` → resolves the API key.
 * - LiteLLM upstreams → resolves the master key.
 * @param config - Validated gateway configuration.
 * @returns Ordered list of credential requests for referenced upstreams only.
 */
function collectCredentialRequests(config: GatewayConfig): UpstreamCredentialRequest[] {
  const requests: UpstreamCredentialRequest[] = [];
  const referenced = collectReferencedUpstreamNames(config);

  for (const [upstreamName, upstream] of Object.entries(config.upstreams)) {
    if (!referenced.has(upstreamName)) continue;
    if (upstream.kind === 'anthropic' && upstream.auth !== undefined) {
      requests.push({ upstreamName, ref: upstream.auth.apiKey });
    } else if (upstream.kind === 'litellm') {
      requests.push({ upstreamName, ref: upstream.masterKey });
    }
  }

  return requests;
}

/**
 * Resolve one credential reference, rejecting an absent or empty value.
 *
 * `site` names the config location that required the credential and appears in
 * the thrown message; the resolved plaintext never does. That message is what
 * reaches the operator log line at the coordinator-ready barrier, so it has to
 * be complete enough to act on and safe enough to print.
 * @param resolver - Host-supplied credential resolver.
 * @param ref - Branded credential reference string to resolve.
 * @param site - Human-readable description of the config site requiring it.
 * @returns The resolved plaintext credential.
 * @throws When the credential resolves to `null` or an empty string.
 */
async function resolveRequiredSecret(resolver: CredentialResolver, ref: CredentialRef, site: string): Promise<string> {
  const value = await resolver.resolve(ref);
  if (!value) {
    throw new Error(`Credential for ${site} (ref "${ref}") could not be resolved.`);
  }
  return value;
}

/**
 * Render a thrown value as the reason shown to the operator.
 *
 * Only the message is kept: every failure raised while resolving credentials is
 * constructed here and names the config site and the reference, never a value.
 * A non-`Error` throw has nothing safe to quote, so it is reported generically
 * rather than stringified — an unknown value could carry anything.
 * @param error - Value thrown while resolving the gateway runtime.
 * @returns A single-sentence reason for the operator log line.
 */
function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : 'Credential resolution failed for an unknown reason.';
}

/**
 * Service that owns the gateway lifecycle.
 *
 * Constructed by the extension manifest's `create` factory and initialised by
 * `ExtensionCoordinator`. After `init()` resolves, `router` exposes the Hono
 * sub-application for mounting via `http.mount`. `init()` performs no I/O and
 * cannot fail on a credential, so mounting never depends on a service that has
 * not started yet.
 */
export class GatewayService extends BaseService {
  private readonly config: GatewayConfig;
  private readonly shutdownSignal: AbortSignal;
  private readonly resolver: CredentialResolver | undefined;
  private readonly logger: GatewayLogger | undefined;
  private _router: Hono | null = null;
  /**
   * Per-init `AbortController` whose signal is passed to the router.
   *
   * Aborted in `onDestroy` so that per-extension disable (`destroy()`) cancels
   * any in-flight upstream fetches without aborting the coordinator-wide
   * {@link shutdownSignal}. Nulled after every destroy and re-created on the
   * next init, supporting init/destroy cycles.
   */
  private _serviceController: AbortController | null = null;
  /**
   * Listener registered on {@link shutdownSignal} so host shutdown cascades
   * into the service-owned controller.
   *
   * Kept as an instance field so it can be removed in `onDestroy`, preventing
   * a residual registration on the long-lived host signal across init/destroy
   * cycles.
   */
  private _onHostShutdown: (() => void) | null = null;
  /**
   * Memoised credential resolution, or `null` when nothing is in flight.
   *
   * Holds the in-flight attempt as well as the settled one, so concurrent
   * requests share a single resolution pass rather than each starting their own.
   * A failed attempt clears itself so the next caller retries; a successful one
   * is kept until `onDestroy` drops it, releasing the plaintexts with it.
   */
  private _runtime: Promise<GatewayRuntime> | null = null;

  /**
   * @param bus - Bus instance for event emission.
   * @param config - Validated and defaulted gateway configuration.
   * @param shutdownSignal - Coordinator-wide shutdown signal from the extension
   *   context. Host shutdown cascades into the service-owned abort controller
   *   so in-flight upstream requests are cancelled when the host stops. The
   *   signal itself is never passed directly to the router — see `onInit`.
   * @param resolver - Host-supplied credential resolver, or `undefined` when
   *   the host does not provide one.
   * @param logger - Sink for the gateway's operator log lines. Passed through
   *   unchanged; both the router and this service fall back through
   *   `resolveGatewayLogger`, so the console default lives in exactly one place.
   */
  public constructor(
    bus: IMakaioBus,
    config: GatewayConfig,
    shutdownSignal: AbortSignal,
    resolver?: CredentialResolver,
    logger?: GatewayLogger,
  ) {
    super(bus);
    this.config = config;
    this.shutdownSignal = shutdownSignal;
    this.resolver = resolver;
    this.logger = logger;
  }

  /**
   * The Hono sub-application that handles gateway routes.
   *
   * Available only after `init()` has completed successfully. The extension
   * coordinator guarantees that `init()` runs before `mount(app)` is called.
   * @returns The ready-to-mount Hono sub-application.
   * @throws When accessed before `init()` completes.
   */
  public get router(): Hono {
    if (this._router === null) {
      throw new Error('GatewayService.router is not available until init() completes.');
    }
    return this._router;
  }

  /**
   * Initialise the gateway.
   *
   * Creates a per-init `AbortController` whose signal is handed to the router.
   * The controller is linked to the coordinator-wide shutdown signal so that
   * host shutdown cancels in-flight upstream requests. A per-extension
   * `destroy()` call aborts the controller directly, without touching the host
   * signal.
   *
   * Builds the router unconditionally: no credential is read here, so nothing
   * about the host's startup order can make activation fail. The router is
   * given a memo that resolves the credentials on first use instead.
   *
   * Registers a handler on the coordinator-ready barrier to warm that memo once
   * every extension has started. That is the first moment a `stored:` reference
   * is certain to be resolvable, so it is also the first moment a failure is
   * worth reporting. The handler is registered through `registerHandler`, so the
   * subscription is unwound with the rest of the service on `destroy()`.
   */
  protected onInit(): void {
    // Build a per-init abort controller so that destroy() can cancel in-flight
    // upstream requests without triggering the coordinator-wide shutdown signal.
    const controller = new AbortController();
    const onHostShutdown = (): void => controller.abort(this.shutdownSignal.reason);
    if (this.shutdownSignal.aborted) {
      // Host already shut down — abort immediately so no upstream request starts.
      controller.abort(this.shutdownSignal.reason);
    } else {
      this.shutdownSignal.addEventListener('abort', onHostShutdown, { once: true });
      this._onHostShutdown = onHostShutdown;
    }
    this._serviceController = controller;

    this._router = createGatewayRouter({
      ensureRuntime: () => this.ensureRuntime(controller),
      maxBodyBytes: this.config.maxBodyBytes,
      shutdownSignal: controller.signal,
      logger: this.logger,
      emit: (event) => {
        // Fire-and-forget: catch prevents an unhandled rejection if the bus
        // has no subscriber or a subscriber throws.
        void this.bus.emit(GatewaySubjects.requestRouted, event).catch(() => {});
      },
    });

    this.registerHandler(KernelSubjects.phase.coordinatorReady, async (ctx) => {
      await this.warmRuntime(controller);
      ctx.setResult({});
    });
  }

  /**
   * Cancel in-flight upstream requests and drop the router reference.
   *
   * Aborting `_serviceController` terminates any upstream `fetch` calls that
   * are still in progress at the moment of teardown — for example when the
   * extension is disabled while an SSE stream is open — without signalling the
   * coordinator-wide {@link shutdownSignal}. The host signal is unaffected.
   *
   * Removing the host-shutdown listener prevents a residual registration from
   * accumulating across init/destroy cycles on the long-lived shutdown signal.
   *
   * Dropping `_runtime` and `_router` releases the memoised credentials and the
   * Hono app that closes over them, allowing every plaintext the gateway held
   * to be garbage-collected even if the module-level `service` variable still
   * references this `GatewayService` instance after destruction. An attempt that
   * is still in flight cannot re-memoise itself afterwards: the memo is keyed on
   * the promise object that was cleared here, so a late result is used by the
   * caller that asked for it and then dropped.
   *
   * The `router` getter will throw again after this runs, matching the
   * pre-`init()` invariant.
   */
  protected override onDestroy(): void {
    // Abort the service-scoped controller, cancelling any in-flight upstream
    // requests dispatched through this init cycle's router.
    this._serviceController?.abort();
    this._serviceController = null;

    // Remove the once-listener from the host signal. If the host already
    // aborted the once listener self-removed, so removeEventListener is a
    // safe no-op in that case.
    if (this._onHostShutdown !== null) {
      this.shutdownSignal.removeEventListener('abort', this._onHostShutdown);
      this._onHostShutdown = null;
    }

    this._runtime = null;
    this._router = null;
  }

  /**
   * Resolve the credential-dependent runtime, reusing a successful resolution.
   *
   * The memo is set synchronously, before the first `await`, so concurrent
   * callers join one attempt instead of each starting a resolution pass of
   * their own. A failure clears it — but only when it is still the attempt that
   * failed, because a `destroy()` (or a later `init()`) may already have
   * replaced it, and clearing that would discard a live result.
   * @param controller - Abort controller owned by the init cycle that built the
   *   router this call came through.
   * @returns The resolved runtime.
   * @throws When the service has been torn down, or when a credential cannot be
   *   resolved.
   */
  private ensureRuntime(controller: AbortController): Promise<GatewayRuntime> {
    if (controller.signal.aborted) {
      // Past teardown or host shutdown. Resolving now would pull fresh
      // plaintexts into a service that is supposed to be holding none.
      return Promise.reject(new Error('The gateway is shutting down and is no longer resolving credentials.'));
    }

    const pending = this._runtime;
    if (pending !== null) {
      return pending;
    }

    const attempt = this.resolveRuntime();
    this._runtime = attempt;
    attempt.catch(() => {
      if (this._runtime === attempt) this._runtime = null;
    });
    return attempt;
  }

  /**
   * Resolve the runtime once at the coordinator-ready barrier, reporting a
   * failure instead of raising it.
   *
   * Raising would fail the barrier and take the host's startup down with it,
   * for a fault that a later request may well resolve on its own. Reporting
   * gives the operator the one thing they need — which reference, at which
   * config site, could not be resolved — while leaving the gateway mounted and
   * able to recover.
   * @param controller - Abort controller owned by this init cycle.
   */
  private async warmRuntime(controller: AbortController): Promise<void> {
    try {
      await this.ensureRuntime(controller);
    } catch (error) {
      logCredentialFailure(resolveGatewayLogger(this.logger), failureReason(error));
    }
  }

  /**
   * Resolve every credential the gateway needs and compile the routing table.
   *
   * Upstream secrets first, then the gateway's own access token, then the
   * table — so a configuration whose upstreams resolve but whose access token
   * does not yields no usable runtime at all, rather than one that would serve
   * traffic without authenticating it.
   * @returns The compiled routing table paired with the resolved access token.
   * @throws When any required credential is missing, empty, or unresolvable.
   */
  private async resolveRuntime(): Promise<GatewayRuntime> {
    const requests = collectCredentialRequests(this.config);
    const resolvedSecrets = await this.resolveUpstreamSecrets(requests);
    const accessToken = await this.resolveAccessToken();
    return { compiled: compileRules(this.config, resolvedSecrets), accessToken };
  }

  /**
   * Resolve all upstream credentials via the host-supplied resolver.
   *
   * When `requests` is empty the resolver is never invoked and an empty map is
   * returned. When the resolver is absent but at least one secret is required,
   * throws immediately with a clear message. The resolved value and any
   * internal resolver detail are never included in thrown messages.
   * @param requests - Ordered list of upstream credential requests.
   * @returns A map from upstream name to resolved plaintext credential.
   * @throws When no resolver is provided but at least one secret is required,
   *   or when any credential resolves to `null` or an empty string.
   */
  private async resolveUpstreamSecrets(requests: UpstreamCredentialRequest[]): Promise<ReadonlyMap<string, string>> {
    if (requests.length === 0) {
      return new Map();
    }

    const resolver = this.requireResolver();
    const resolved = new Map<string, string>();

    for (const { upstreamName, ref } of requests) {
      resolved.set(upstreamName, await resolveRequiredSecret(resolver, ref, `upstream "${upstreamName}"`));
    }

    return resolved;
  }

  /**
   * Resolve the gateway's own access token, when one is configured.
   *
   * Unlike upstream secrets, this reference is never pruned: an `accessToken`
   * that is present in config but unresolvable must fail the whole resolution
   * rather than silently leave the proxy unauthenticated. The gateway then
   * answers `503` until the reference resolves — closed, not open.
   * @returns The resolved plaintext token, or `null` when none is configured.
   * @throws When a token is configured but no resolver is available, or when it
   *   resolves to `null` or an empty string.
   */
  private async resolveAccessToken(): Promise<string | null> {
    const ref = this.config.accessToken;
    if (ref === undefined) {
      return null;
    }
    return resolveRequiredSecret(this.requireResolver(), ref, 'gateway "accessToken"');
  }

  /**
   * Return the host-supplied credential resolver, or fail the resolution.
   * @returns The host-supplied credential resolver.
   * @throws When the host provides no credential resolver.
   */
  private requireResolver(): CredentialResolver {
    if (this.resolver === undefined) {
      throw new Error(
        'This host does not provide credential resolution. ' +
          'Use a host that supplies a credential resolver, or configure ' +
          'the gateway without secrets.',
      );
    }
    return this.resolver;
  }
}
