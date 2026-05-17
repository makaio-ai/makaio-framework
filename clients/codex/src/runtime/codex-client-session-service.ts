/**
 * Codex client session normalization service.
 *
 * Subscribes to raw Codex hook events on `client:codex.hook.received` and
 * emits the corresponding normalized `client.session.*` observations via
 * {@link normalizeCodexHook}.
 *
 * Also handles config management requests on `client:codex.config.hooks.*`
 * subjects. Before constructing settings I/O, the service resolves the active
 * config directory via `client.resolveBinary` and uses that as the global
 * Codex config root, falling back to native `~/.codex` paths when no resolver
 * or global binary is available. Wiring requests use the same settings path
 * resolution. The service also handles the blocking `client:codex.config.prime`
 * lifecycle hook and the `client:codex.sessionConfig.setup` delegation subject
 * for per-session config directory initialization.
 *
 * Unknown or not-yet-modeled event names are silently dropped — they stay
 * raw-only inside the `client:codex.*` namespace and are never forwarded to
 * the global `client.*` namespace.
 *
 * ## Adapter-managed session gate
 *
 * When both the native-hook ingress and the adapter-derived path are active for
 * the same Codex process, `client.session.started` would otherwise be emitted
 * twice.  The service listens to `client.runtime.started` events: when an event
 * arrives with `clientId === CLIENT_ID`, `source.layer === 'adapter'`, and a
 * non-empty `adapterSessionId`, that session ID is recorded as adapter-managed.
 * Any subsequent normalized hook for the same `adapterSessionId` is then
 * silently dropped — the adapter path already owns the canonical emission.
 * Sessions whose `adapterSessionId` is absent or not yet registered emit as
 * before (fail-open).  Events from other clients (e.g. `'claude-code'`,
 * `'gemini'`) are ignored unconditionally — their adapter sessions must not
 * suppress Codex hook emissions.
 *
 * The managed-session set is bounded at {@link MANAGED_SESSION_CAP} entries to
 * prevent unbounded growth in long-lived processes.  When the cap is reached,
 * the oldest recorded session ID is evicted before inserting the new one
 * (FIFO).
 * @packageDocumentation
 */

import type { IMakaioBus } from '@makaio/bus-core';
import { MakaioBus, RequestError } from '@makaio/bus-core';
import { BinaryNotFoundError, ClientSubjects, assertAbsoluteProjectDir } from '@makaio/clients-core';
import type { ClientRuntimeStarted } from '@makaio/contracts/client';
import { BaseService } from '@makaio/service-base';
import { CodexClientSettings } from './client-settings.js';
import { handleCodexConfigPrime } from './config-prime-handler.js';
import { normalizeCodexHook } from './hook-normalizer.js';
import { CodexClientSubjects } from './namespace.js';
import { handleCodexSessionConfigSetup } from './session-config-handler.js';
import { applyCodexWiring, buildCodexWiringList, removeCodexWiring } from './wiring.js';

/** Stable client ID for Codex — used to filter `client.runtime.started` events. */
const CLIENT_ID = 'codex';

/**
 * Maximum number of adapter-managed session IDs retained in
 * {@link CodexClientSessionService.managedAdapterSessionIds}.
 *
 * Concurrent active Codex sessions are typically single-digit, so this
 * cap is a safety net against unbounded growth in long-lived processes.  When
 * the cap is reached, the oldest recorded ID is evicted (FIFO) before the new
 * one is inserted.
 */
export const MANAGED_SESSION_CAP = 10_000;

/**
 * Service that normalizes raw Codex hook events into global
 * `client.session.*` observed-semantics events and handles Codex config
 * management requests on `client:codex.config.hooks.*`.
 *
 * Lifecycle:
 * 1. `init()` — subscribes to `client:codex.hook.received`, subscribes to
 *    `client.runtime.started` for the adapter-managed session gate, and
 *    registers request handlers for `config.hooks.list`, `config.hooks.add`,
 *    `config.hooks.remove`, `config.prime`, `wiring.list`, `wiring.apply`,
 *    `wiring.remove`, and `sessionConfig.setup`.
 * 2. On each incoming raw event, calls {@link normalizeCodexHook}.
 * 3. Emits the normalized subject when the event is recognized; silently
 *    ignores unknown events.  Normalized `client.session.*` events are
 *    suppressed when the `adapterSessionId` is already in the adapter-managed
 *    set.
 * 4. `destroy()` — unsubscribes all handlers automatically via `BaseService`.
 */
export class CodexClientSessionService extends BaseService {
  /** Optional injected settings I/O delegate for tests. */
  private readonly settingsOverride: CodexClientSettings | undefined;
  /** Cached active config-dir resolution; reset when the active Codex version changes. */
  private cachedConfigDir: Promise<string | undefined> | undefined;

  /**
   * Set of `adapterSessionId` values known to be owned by an adapter-managed
   * Codex runtime.  Populated by {@link handleRuntimeStarted} when a
   * `client.runtime.started` event arrives with `clientId === CLIENT_ID` and
   * `source.layer === 'adapter'`.
   *
   * Bounded at {@link MANAGED_SESSION_CAP} entries — the oldest ID is evicted
   * (FIFO) when the cap is reached.
   *
   * Used by {@link handleHookReceived} to gate duplicate `client.session.*`
   * emissions for sessions that the adapter path already covers.
   */
  private readonly managedAdapterSessionIds = new Set<string>();

  /**
   * Creates a new Codex client session service.
   * @param bus - Bus instance used for subscribing and emitting events
   * @param settings - Optional {@link CodexClientSettings} instance for tests
   *   that need exact filesystem paths. Production callers should omit it so
   *   the service can resolve the active managed config dir via the bus.
   */
  public constructor(bus: IMakaioBus = MakaioBus, settings?: CodexClientSettings) {
    super(bus);
    this.settingsOverride = settings;
  }

  /**
   * Register the raw hook ingress handler, config management request handlers,
   * wiring management request handlers, the config-prime lifecycle handler,
   * and the session config setup handler on the bus.
   *
   * Also subscribes to `client.runtime.started` to track adapter-managed
   * sessions for the {@link handleHookReceived} suppression gate.
   */
  protected override onInit(): void {
    this.registerHandler(ClientSubjects.runtime.started, ({ payload }) => {
      this.handleRuntimeStarted(payload);
    });
    this.registerHandler(ClientSubjects.version.changed, ({ payload }) => {
      if (payload.clientId === CLIENT_ID) {
        this.cachedConfigDir = undefined;
      }
    });

    this.registerHandler(CodexClientSubjects.hook.received, async ({ payload }) => {
      await this.handleHookReceived(payload);
    });

    this.registerHandler(CodexClientSubjects.config.hooks.list, async (ctx) => {
      ctx.setResult(await (await this.createSettings()).listHooks(ctx.payload));
    });

    this.registerHandler(CodexClientSubjects.config.hooks.add, async (ctx) => {
      ctx.setResult(await (await this.createSettings()).addHook(ctx.payload));
    });

    this.registerHandler(CodexClientSubjects.config.hooks.remove, async (ctx) => {
      ctx.setResult(await (await this.createSettings()).removeHook(ctx.payload));
    });

    this.registerHandler(CodexClientSubjects.wiring.list, async (ctx) => {
      assertAbsoluteProjectDir(ctx.payload.projectDir);
      ctx.setResult(
        await buildCodexWiringList(await this.createSettings(), ctx.payload.makaioCommand, ctx.payload.projectDir),
      );
    });

    this.registerHandler(CodexClientSubjects.wiring.apply, async (ctx) => {
      assertAbsoluteProjectDir(ctx.payload.projectDir);
      if (ctx.payload.scope === 'project' && !ctx.payload.projectDir) {
        throw new Error("projectDir is required when scope is 'project'");
      }
      ctx.setResult(
        await applyCodexWiring(
          await this.createSettings(),
          ctx.payload.scope,
          ctx.payload.makaioCommand,
          ctx.payload.projectDir,
        ),
      );
    });

    this.registerHandler(CodexClientSubjects.wiring.remove, async (ctx) => {
      assertAbsoluteProjectDir(ctx.payload.projectDir);
      if (ctx.payload.scope === 'project' && !ctx.payload.projectDir) {
        throw new Error("projectDir is required when scope is 'project'");
      }
      ctx.setResult(await removeCodexWiring(await this.createSettings(), ctx.payload.scope, ctx.payload.projectDir));
    });

    this.registerHandler(CodexClientSubjects.config.prime, async (ctx) => {
      ctx.setResult(await handleCodexConfigPrime(ctx.payload));
    });

    this.registerHandler(CodexClientSubjects.sessionConfig.setup, async (ctx) => {
      ctx.setResult(await handleCodexSessionConfigSetup(ctx.payload));
    });
  }

  /**
   * Clear the adapter-managed session ID set on teardown.
   */
  protected override onDestroy(): void {
    this.managedAdapterSessionIds.clear();
    this.cachedConfigDir = undefined;
  }

  /**
   * Create a settings delegate for the active Codex config root.
   * @returns Settings instance bound to the managed config dir when available.
   */
  private async createSettings(): Promise<CodexClientSettings> {
    if (this.settingsOverride !== undefined) {
      return this.settingsOverride;
    }
    const configDir = await this.resolveConfigDir();
    return new CodexClientSettings(configDir !== undefined ? { configDir } : undefined);
  }

  /**
   * Return the cached config directory promise, resolving it on first access.
   *
   * Missing binary resolution is a graceful fallback so config reads/writes can
   * still target native Codex config paths in framework-only or global-only
   * setups.
   * @returns Absolute managed config dir, or `undefined` to use native paths.
   */
  private resolveConfigDir(): Promise<string | undefined> {
    if (this.cachedConfigDir === undefined) {
      const pendingConfigDir = this.doResolveConfigDir().then(
        (configDir) => {
          if (configDir === undefined && this.cachedConfigDir === pendingConfigDir) {
            this.cachedConfigDir = undefined;
          }
          return configDir;
        },
        (error: unknown) => {
          if (this.cachedConfigDir === pendingConfigDir) {
            this.cachedConfigDir = undefined;
          }
          throw error;
        },
      );
      this.cachedConfigDir = pendingConfigDir;
    }
    return this.cachedConfigDir;
  }

  /**
   * Resolve the active Codex config dir via `client.resolveBinary`.
   * @returns Config directory returned by the binary resolver, or `undefined`
   *   when no resolver/global binary is available.
   */
  private async doResolveConfigDir(): Promise<string | undefined> {
    let result;
    try {
      result = await this.bus.requestOptional(ClientSubjects.resolveBinary, { clientId: CLIENT_ID });
    } catch (error) {
      if (isResolveBinaryMissingGlobalBinary(error)) {
        return undefined;
      }
      throw error;
    }
    if (!result.handled) {
      return undefined;
    }
    return result.data.configDir ?? undefined;
  }

  /**
   * Record a runtime as adapter-managed when the evidence source is an adapter.
   *
   * Called for every `client.runtime.started` event.  Only events whose
   * `clientId` equals `'codex'`, whose `source.layer` is `'adapter'`, and
   * that carry a non-empty `adapterSessionId` update the managed-sessions gate.
   * Events from other clients (e.g. `'claude-code'`, `'gemini'`) are ignored
   * unconditionally — their adapter sessions must not suppress Codex hook
   * emissions.  Non-adapter sources (e.g. `'supervisor'`, `'statusline'`) are
   * also ignored to prevent accidental suppression of native hook paths.
   *
   * When the set reaches {@link MANAGED_SESSION_CAP}, the oldest entry is
   * evicted before the new ID is inserted.
   * @param payload - `client.runtime.started` payload
   */
  private handleRuntimeStarted(payload: ClientRuntimeStarted): void {
    if (payload.clientId !== CLIENT_ID) {
      return;
    }
    if (payload.source.layer === 'adapter' && payload.adapterSessionId) {
      if (this.managedAdapterSessionIds.has(payload.adapterSessionId)) {
        return;
      }
      if (this.managedAdapterSessionIds.size >= MANAGED_SESSION_CAP) {
        const oldest = this.managedAdapterSessionIds.values().next().value;
        if (oldest !== undefined) {
          this.managedAdapterSessionIds.delete(oldest);
        }
      }
      this.managedAdapterSessionIds.add(payload.adapterSessionId);
    }
  }

  /**
   * Translate a raw Codex hook event into a normalized `client.session.*` emission.
   *
   * Unknown / Codex-specific events produce no emission and are silently
   * ignored. The raw event remains observable on `client:codex.*` for
   * consumers that need Codex-native detail.
   * @param raw - Raw hook payload delivered on `client:codex.hook.received`
   */
  private async handleHookReceived(raw: Parameters<typeof normalizeCodexHook>[0]): Promise<void> {
    const normalized = normalizeCodexHook(raw);
    if (normalized === null) return;

    if (this.isAdapterManagedSession(normalized.payload.adapterSessionId)) {
      // The adapter path owns the complete normalized client.session.* surface
      // for this session. Native hooks remain observable in client:codex.*, but
      // forwarding them globally would duplicate downstream session semantics.
      return;
    }

    switch (normalized.subject) {
      case ClientSubjects.session.started:
        await this.bus.emit(ClientSubjects.session.started, normalized.payload);
        break;
      case ClientSubjects.session.userPrompt.submitted:
        await this.bus.emit(ClientSubjects.session.userPrompt.submitted, normalized.payload);
        break;
      case ClientSubjects.session.turn.completed:
        await this.bus.emit(ClientSubjects.session.turn.completed, normalized.payload);
        break;
      case ClientSubjects.session.tool.pre:
        await this.bus.emit(ClientSubjects.session.tool.pre, normalized.payload);
        break;
      case ClientSubjects.session.tool.post:
        await this.bus.emit(ClientSubjects.session.tool.post, normalized.payload);
        break;
      default:
        throwUnhandledNormalizedEvent(normalized);
    }
  }

  /**
   * Determine whether a normalized native hook belongs to an adapter-managed
   * session whose global observed-semantics events are already emitted by the
   * adapter layer.
   * @param adapterSessionId - Adapter/session identifier from the normalized hook
   * @returns True when the native hook should remain raw-only
   */
  private isAdapterManagedSession(adapterSessionId: string | undefined): boolean {
    return adapterSessionId !== undefined && this.managedAdapterSessionIds.has(adapterSessionId);
  }
}

/**
 * Fail fast when the normalizer grows a new subject but service emission has
 * not been updated to preserve the normalized-event contract.
 *
 * The broad parameter type is intentional — the switch operates on
 * `SubjectDefinition` subject strings rather than a discriminated union, so
 * TypeScript cannot narrow `normalized` to `never` in the default branch.
 * Compile-time exhaustiveness is enforced by the normalizer's return type
 * and the matching set of case branches above.
 * @param event - Normalized event whose subject is not emitted above
 */
function throwUnhandledNormalizedEvent(event: { readonly subject: { readonly subject: string } }): never {
  const subject = event.subject.subject;
  throw new Error(`Unhandled normalized Codex hook subject: ${subject}`);
}

/**
 * Return true when `client.resolveBinary` only failed because no Codex
 * executable was found. Config and wiring requests can still use Codex's
 * default native settings path in that case; other resolution failures should
 * propagate.
 * @param error - Error thrown by the bus request.
 * @returns True when the error is the global-binary fallback miss.
 */
function isResolveBinaryMissingGlobalBinary(error: unknown): boolean {
  if (!(error instanceof RequestError)) {
    return false;
  }
  return error.subject?.endsWith('resolveBinary') === true && error.cause instanceof BinaryNotFoundError;
}
