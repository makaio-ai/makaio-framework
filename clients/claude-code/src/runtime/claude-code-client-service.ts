/**
 * Claude Code client runtime service.
 *
 * Subscribes to `client:claude-code.hook.received` events and translates them
 * into normalized `client.session.*` observed-semantics emissions.  Also
 * registers a request handler on `client:claude-code.hook.handle` for
 * request-mode hook events (e.g. `PreToolUse`) that need a response.  Raw events
 * that do not map to the v1 set (Notification, MCPServerStart, etc.) are
 * silently ignored — they remain observable in `client:claude-code.*` for
 * consumers that care about Claude-specific extras.
 *
 * Also subscribes to `client:claude-code.statusline.received` events.  For
 * each payload that carries a `session_id`, the service resolves the account
 * identity (via session storage or active-account fallback) and caches it per
 * session to avoid repeated bus lookups within the same turn.  The cache is
 * cleared whenever `account.activate` fires for Claude Code, so an account
 * switch between turns causes the next statusline event to re-resolve identity
 * against the newly active account.  When both an
 * identity and rate-limit data are present, the payload is passed to
 * {@link normalizeClaudeCodeStatusline} together with the resolved identity
 * context and the resulting request is forwarded to `client.usage.ingest`.
 * Payloads without a `session_id`, sessions that have not yet been linked to a
 * client account, or sessions without stored identity evidence are silently
 * skipped — the raw event remains observable on
 * `client:claude-code.statusline.received`.
 *
 * Also registers request handlers for all six `config.*` subjects, delegating
 * to a per-request {@link ClaudeCodeClientSettings} instance scoped to the
 * `projectDir` carried in each request payload.  Before constructing each
 * settings instance, the service resolves the active config directory via
 * `client.resolveBinary` (using `requestOptional` for graceful fallback in
 * framework-only boot) and passes it as `configDir` so that hooks and config
 * reads/writes land in the correct isolated directory.  The resolved value is
 * cached for the lifetime of the active binary and invalidated when
 * `client.version.changed` fires for `clientId === 'claude-code'`.
 *
 * ## Ingress invariant
 *
 * The subscription listens to the **catch-all** `hook.received` subject without
 * any event-name pre-filtering.  Filtering happens inside
 * {@link normalizeClaudeCodeHook}, which returns an empty array for unknown
 * events.  This guarantees that raw hook ingress reaches the bus before any
 * semantic narrowing — preventing the adapter-level subtype filtering
 * anti-pattern.
 *
 * ## Adapter-managed session gate
 *
 * When both the native-hook ingress and the adapter-derived path are active for
 * the same Claude process, `client.session.started` would otherwise be emitted
 * twice.  The service listens to `client.runtime.started` events: when an event
 * arrives with `clientId === CLIENT_ID`, `source.layer === 'adapter'`, and a
 * non-empty `adapterSessionId`, that session ID is recorded as adapter-managed.
 * A subsequent `SessionStart` hook for the same `adapterSessionId` is then
 * silently dropped — the adapter path already owns the canonical emission.
 * Sessions whose `adapterSessionId` is absent or not yet registered emit as
 * before (fail-open).  Events from other clients (e.g. `'codex'`, `'gemini'`)
 * are ignored unconditionally — their adapter sessions must not suppress Claude
 * Code hook emissions.
 *
 * The managed-session set is bounded at {@link MANAGED_SESSION_CAP} entries to
 * prevent unbounded growth in long-lived processes.  When the cap is reached,
 * the oldest recorded session ID is evicted before inserting the new one
 * (FIFO).  In practice, concurrent active Claude Code sessions are measured in
 * single digits, so the cap is purely a safety net.
 * @packageDocumentation
 */

import { MakaioBus, RequestError, type IMakaioBus } from '@makaio/bus-core';
import {
  BinaryNotFoundError,
  ClientSubjects,
  assertAbsoluteProjectDir,
  type ClientHookHandleResponse,
  type RawClientHookPayload,
} from '@makaio/subsystem-client';
import { ClientAccountIdentifierSchema, type ClientRuntimeStarted } from '@makaio/contracts/client';
import { SessionStorageSubjects } from '@makaio/contracts/session';
import { BaseService } from '@makaio/service-base';
import { z } from 'zod';
import { ClaudeCodeClientSettings } from './client-settings.js';
import { handleClaudeCodeConfigPrime } from './config-prime-handler.js';
import { normalizeClaudeCodeHook, type ClaudeCodeNormalizedEvent } from './hook-normalizer.js';
import { normalizeClaudeCodeStatusline, type StatuslineIdentityContext } from './statusline-normalizer.js';
import { ClaudeCodeClientSubjects } from './namespace.js';
import { handleClaudeCodeSessionConfigSetup } from './session-config-handler.js';
import { clearClaudeCodeNativeCredentialsForSession } from './native-credentials.js';
import { buildClaudeCodeWiringList, applyClaudeCodeWiring, removeClaudeCodeWiring } from './wiring.js';

/** Stable client ID for Claude Code — used to filter `client.runtime.started` events. */
const CLIENT_ID = 'claude-code';

/**
 * Maximum number of adapter-managed session IDs retained in
 * {@link ClaudeCodeClientService.managedAdapterSessionIds}.
 *
 * Concurrent active Claude Code sessions are typically single-digit, so this
 * cap is a safety net against unbounded growth in long-lived processes.  When
 * the cap is reached, the oldest recorded ID is evicted (FIFO) before the new
 * one is inserted.
 */
const MANAGED_SESSION_CAP = 10_000;

/**
 * Maximum number of per-statusline session identities retained for usage
 * attribution.
 *
 * Uses the same cap as adapter-managed sessions because both collections are
 * keyed by Claude Code session IDs and share the same long-lived service
 * lifecycle.
 */
const SESSION_IDENTITY_CACHE_CAP = MANAGED_SESSION_CAP;

/**
 * Runtime service for the Claude Code client.
 *
 * Listens to the raw hook catch-all ingress subject
 * (`client:claude-code.hook.received`) and forwards normalized lifecycle
 * observations onto the global `client.session.*` contract.
 *
 * Also listens to `client:claude-code.statusline.received` and, for payloads
 * whose `session_id` maps to a session with a linked `clientAccountId`, passes
 * the payload through {@link normalizeClaudeCodeStatusline} and forwards the
 * result to `client.usage.ingest`.
 *
 * Handles all six `config.*` request subjects for reading and writing
 * Claude Code native settings files across user, project, and local scopes.
 *
 * Also handles the three `wiring.*` request subjects for listing, applying,
 * and removing the Makaio hook wiring entries.
 *
 * Also handles the `hook.handle` request subject for request-mode hook events
 * (e.g. `PreToolUse`), returning a {@link ClientHookHandleResponse} that the
 * CLI bridge forwards to the client binary as its stdout.
 *
 * Instantiate via the runtime package and call `init()` once per process.
 */
export class ClaudeCodeClientService extends BaseService {
  /**
   * Set of `adapterSessionId` values known to be owned by an adapter-managed
   * Claude Code runtime.  Populated by {@link handleRuntimeStarted} when a
   * `client.runtime.started` event arrives with `clientId === CLIENT_ID` and
   * `source.layer === 'adapter'`.
   *
   * Bounded at {@link MANAGED_SESSION_CAP} entries — the oldest ID is evicted
   * (FIFO) when the cap is reached.
   *
   * Used by {@link handleHookReceived} to gate duplicate `client.session.started`
   * emissions for sessions that the adapter path already covers.
   */
  private readonly managedAdapterSessionIds = new Set<string>();

  /**
   * Per-session identity cache for statusline usage attribution.
   *
   * Identity is resolved on the first statusline event for each `session_id`
   * and cached so that subsequent events within the same turn avoid repeated
   * bus lookups.  The cache is **cleared** whenever `account.activate` fires
   * for Claude Code, ensuring that an account switch between turns causes the
   * next statusline event to re-resolve identity against the new active account.
   *
   * Bounded at {@link SESSION_IDENTITY_CACHE_CAP} entries — the oldest identity
   * is evicted (FIFO) before inserting a new session when the cap is reached.
   */
  private readonly sessionIdentityCache = new Map<string, StatuslineIdentityContext>();

  /**
   * Monotonic generation for {@link sessionIdentityCache}.
   *
   * Account switches and service teardown invalidate in-flight statusline
   * resolutions.  Handlers that started before the generation changed may
   * still emit their already-observed statusline payload, but they must not
   * repopulate the cache with stale identity after the invalidation.
   */
  private sessionIdentityCacheEpoch = 0;

  /**
   * Cached promise for the resolved config directory.
   *
   * A concrete config directory is stable within a process lifetime — it can
   * only change when the active binary changes (i.e.
   * `client.version.changed` fires for `clientId === 'claude-code'`).  Caching
   * the promise avoids a bus round-trip on every config handler invocation.
   * Missing handlers, absent global binaries, and failures are not cached
   * because the binary subsystem may register later or recover independently.
   *
   * Set lazily by the first call to {@link resolveConfigDir} and invalidated
   * by the `client.version.changed` subscription registered in {@link onInit}.
   */
  private cachedConfigDir: Promise<string | undefined> | undefined;

  /**
   * Stable runtime identity of the machine that owns the client sessions
   * observed by this service.  Stamped onto `client.session.started` payloads
   * so downstream storage receives the owning machine's identity without
   * deriving it from the writer process.
   */
  private readonly machineId: string | undefined;

  /**
   * Creates a new Claude Code client service.
   * @param bus - Bus instance used for hook subscription and semantic emission.
   *   Defaults to the global {@link MakaioBus} singleton.
   * @param machineId - Stable runtime identity of the observing machine,
   *   caller-supplied from the extension context. Omit in tests or when the
   *   identity is unavailable.
   */
  public constructor(bus: IMakaioBus = MakaioBus, machineId?: string) {
    super(bus);
    this.machineId = machineId;
  }

  /**
   * Register the hook ingress subscription, the hook handle request handler,
   * all config request handlers, all wiring request handlers, and the session
   * config setup handler on the bus.
   *
   * Also subscribes to `client.runtime.started` to track adapter-managed
   * sessions for the {@link handleHookReceived} suppression gate.
   *
   * Called once by `BaseService.init()`.  All subsequent calls are no-ops.
   */
  protected override onInit(): void {
    this.registerHandler(ClientSubjects.runtime.started, ({ payload }) => {
      this.handleRuntimeStarted(payload);
    });

    // Invalidate the cached config dir whenever the active binary changes for
    // this client.  The next handler invocation will re-resolve and re-cache.
    this.registerHandler(ClientSubjects.version.changed, ({ payload }) => {
      if (payload.clientId === CLIENT_ID) {
        this.cachedConfigDir = undefined;
      }
    });

    // Invalidate the session identity cache when the active Claude Code account
    // changes.  Claude Code uses whichever account is active at turn start, so
    // a mid-session account switch must re-resolve identity on the next
    // statusline event rather than reusing the previously pinned value.
    this.registerHandler(ClientSubjects.account.activate, ({ payload }) => {
      if (payload.clientId === CLIENT_ID) {
        this.sessionIdentityCacheEpoch += 1;
        this.sessionIdentityCache.clear();
      }
    });

    this.registerHandler(ClaudeCodeClientSubjects.hook.received, async ({ payload }) => {
      await this.handleHookReceived(payload);
    });

    this.registerHandler(ClaudeCodeClientSubjects.statusline.received, async ({ payload }) => {
      await this.handleStatuslineReceived(payload);
    });

    this.registerHookHandleHandler();
    this.registerConfigHandlers();
    this.registerConfigPrimeHandler();
    this.registerSessionConfigHandler();
    this.registerMcpServersHandlers();
    this.registerWiringHandlers();
  }

  /**
   * Clear the adapter-managed session ID set, session identity cache, and
   * config dir cache on teardown.
   */
  protected override onDestroy(): void {
    this.managedAdapterSessionIds.clear();
    this.sessionIdentityCacheEpoch += 1;
    this.sessionIdentityCache.clear();
    this.cachedConfigDir = undefined;
  }

  /**
   * Register Claude Code native config handlers.
   */
  private registerConfigHandlers(): void {
    this.registerHandler(ClaudeCodeClientSubjects.config.statusline.list, async (ctx) => {
      ctx.setResult(await (await this.createSettings(ctx.payload.projectDir)).listStatusline());
    });

    this.registerHandler(ClaudeCodeClientSubjects.config.statusline.set, async (ctx) => {
      ctx.setResult(await (await this.createSettings(ctx.payload.projectDir)).setStatusline(ctx.payload));
    });

    this.registerHandler(ClaudeCodeClientSubjects.config.hooks.list, async (ctx) => {
      ctx.setResult(await (await this.createSettings(ctx.payload.projectDir)).listHooks(ctx.payload));
    });

    this.registerHandler(ClaudeCodeClientSubjects.config.hooks.add, async (ctx) => {
      ctx.setResult(await (await this.createSettings(ctx.payload.projectDir)).addHook(ctx.payload));
    });

    this.registerHandler(ClaudeCodeClientSubjects.config.hooks.remove, async (ctx) => {
      ctx.setResult(await (await this.createSettings(ctx.payload.projectDir)).removeHook(ctx.payload));
    });

    this.registerHandler(ClaudeCodeClientSubjects.config.plugins.list, async (ctx) => {
      ctx.setResult(await (await this.createSettings(ctx.payload.projectDir)).listPlugins());
    });
  }

  /**
   * Register the `config.prime` handler.
   *
   * Delegates to {@link handleClaudeCodeConfigPrime} which ensures the target
   * config directory's `settings.json` has `DISABLE_AUTOUPDATER=1` set,
   * preventing Claude Code from self-updating while running under Makaio's
   * binary lifecycle management.
   *
   * Extracted from {@link onInit} to keep the init method within the
   * max-lines-per-function lint threshold.
   */
  private registerConfigPrimeHandler(): void {
    this.registerHandler(ClaudeCodeClientSubjects.config.prime, async (ctx) => {
      ctx.setResult(await handleClaudeCodeConfigPrime(ctx.payload));
    });
  }

  /**
   * Register Claude Code wiring handlers.
   */
  private registerWiringHandlers(): void {
    this.registerHandler(ClaudeCodeClientSubjects.wiring.list, async (ctx) => {
      assertAbsoluteProjectDir(ctx.payload.projectDir);
      const settings = await this.createSettings(ctx.payload.projectDir);
      ctx.setResult(await buildClaudeCodeWiringList(settings, ctx.payload.makaioCommand, ctx.payload.envPairs));
    });

    this.registerHandler(ClaudeCodeClientSubjects.wiring.apply, async (ctx) => {
      assertAbsoluteProjectDir(ctx.payload.projectDir);
      if ((ctx.payload.scope === 'project' || ctx.payload.scope === 'local') && !ctx.payload.projectDir) {
        throw new Error(`projectDir is required when scope is '${ctx.payload.scope}'`);
      }
      const configDir = ctx.payload.configDir ?? (await this.resolveConfigDir());
      const settings = new ClaudeCodeClientSettings({ projectDir: ctx.payload.projectDir, configDir });
      ctx.setResult(
        await applyClaudeCodeWiring(settings, ctx.payload.scope, ctx.payload.makaioCommand, ctx.payload.envPairs, {
          skipDangerousModePermissionPrompt: ctx.payload.skipDangerousModePermissionPrompt,
        }),
      );
    });

    this.registerHandler(ClaudeCodeClientSubjects.wiring.remove, async (ctx) => {
      assertAbsoluteProjectDir(ctx.payload.projectDir);
      if ((ctx.payload.scope === 'project' || ctx.payload.scope === 'local') && !ctx.payload.projectDir) {
        throw new Error(`projectDir is required when scope is '${ctx.payload.scope}'`);
      }
      ctx.setResult(await removeClaudeCodeWiring(await this.createSettings(ctx.payload.projectDir), ctx.payload.scope));
    });
  }

  /**
   * Create a settings instance for the resolved global config directory.
   * @param projectDir - Optional project directory for project-scoped settings.
   * @returns Settings instance bound to the resolved config directory.
   */
  private async createSettings(projectDir?: string): Promise<ClaudeCodeClientSettings> {
    return new ClaudeCodeClientSettings({ projectDir, configDir: await this.resolveConfigDir() });
  }

  /**
   * Return the cached config directory promise, resolving it on first access.
   *
   * Only concrete config directories are cached. Missing resolution is a
   * graceful fallback, not a stable state: the binary manager may register
   * later in the same process.
   * @returns Absolute path to the isolated config directory, or `undefined`
   *   when no binary resolution handler is registered or the resolved context
   *   carries no config dir.
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
   * Execute the `client.resolveBinary` bus request and extract the config dir.
   *
   * Uses `requestOptional` so that the call is safe in framework-only boot
   * (i.e. when no `resolveBinary` handler is registered) — in that case
   * `undefined` is returned and settings construction falls back to the default
   * `~/.claude/settings.json` path.
   * @returns Absolute path to the isolated config directory, or `undefined`
   *   when no binary resolution handler is registered or the resolved context
   *   carries no config dir.
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
   * Register the `sessionConfig.setup` handler.
   *
   * Delegates setup to the client-owned session config handler. The handler
   * owns Claude Code's native fallback when no profile base exists and returns
   * the `CLAUDE_CONFIG_DIR` env var so the spawned process inherits the
   * isolated session directory as its configuration root.
   *
   * Extracted from {@link onInit} to keep the init method within the
   * max-lines-per-function lint threshold.
   */
  private registerSessionConfigHandler(): void {
    this.registerHandler(ClaudeCodeClientSubjects.sessionConfig.setup, async (ctx) => {
      const result = await handleClaudeCodeSessionConfigSetup(ctx.payload);
      ctx.setResult(result);
    });
    this.registerHandler(ClaudeCodeClientSubjects.sessionConfig.destroy, async (ctx) => {
      await clearClaudeCodeNativeCredentialsForSession(ctx.payload);
      ctx.setResult({ success: true });
    });
  }

  /**
   * Register bus handlers for the `config.mcpServers.*` subjects.
   *
   * Extracted from {@link onInit} to keep the init method within the
   * max-lines-per-function lint threshold.
   */
  private registerMcpServersHandlers(): void {
    this.registerHandler(ClaudeCodeClientSubjects.config.mcpServers.list, async (ctx) => {
      ctx.setResult(await (await this.createSettings(ctx.payload.projectDir)).listMcpServers());
    });

    this.registerHandler(ClaudeCodeClientSubjects.config.mcpServers.add, async (ctx) => {
      ctx.setResult(await (await this.createSettings(ctx.payload.projectDir)).addMcpServer(ctx.payload));
    });

    this.registerHandler(ClaudeCodeClientSubjects.config.mcpServers.remove, async (ctx) => {
      ctx.setResult(await (await this.createSettings(ctx.payload.projectDir)).removeMcpServer(ctx.payload));
    });
  }

  /**
   * Register the `hook.handle` request handler.
   *
   * The handler receives request-mode hook payloads (e.g. `PreToolUse`) and
   * returns a {@link ClientHookHandleResponse} that the CLI bridge writes to
   * stdout so the client binary can read it.
   *
   * Dispatches to a per-event handler via {@link handleHookRequest}.
   * Events with no dedicated handler return the no-op default response
   * (`exitCode: 0, stdout: '', stderr: ''`).
   *
   * Extracted from {@link onInit} to keep the init method within the
   * max-lines-per-function lint threshold.
   */
  private registerHookHandleHandler(): void {
    this.registerHandler(ClaudeCodeClientSubjects.hook.handle, async (ctx) => {
      ctx.setResult(await this.handleHookRequest(ctx.payload));
    });
  }

  /**
   * Dispatch a raw hook handle payload to the appropriate per-event handler.
   *
   * Returns the no-op default response for any event without a dedicated
   * handler.  This keeps the dispatch table minimal and future-proof: new
   * request-mode events can add a handler branch without touching the
   * registration plumbing.
   * @param payload - Raw hook payload delivered on `client:claude-code.hook.handle`.
   * @returns Response to forward to the client binary via stdout.
   */
  private async handleHookRequest(payload: RawClientHookPayload): Promise<ClientHookHandleResponse> {
    switch (payload.eventName) {
      case 'PreToolUse':
        return this.handlePreToolUse(payload);
      default:
        return { exitCode: 0, stdout: '', stderr: '' };
    }
  }

  /**
   * Handle a `PreToolUse` request-mode hook.
   *
   * Native hook payloads do not yet provide a reliable agent/session correlation
   * key for bus-mediated tool policy requests.  Until that contract exists this
   * handler remains a fail-open passthrough.
   * @param _payload - Raw `PreToolUse` hook payload, currently unused while the
   *   handler is a passthrough.
   * @returns No-op response that permits the tool invocation to proceed.
   */
  private async handlePreToolUse(_payload: RawClientHookPayload): Promise<ClientHookHandleResponse> {
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  /**
   * Record a runtime as adapter-managed when the evidence source is an adapter.
   *
   * Called for every `client.runtime.started` event.  Only events whose
   * `clientId` equals `'claude-code'`, whose `source.layer` is `'adapter'`, and
   * that carry a non-empty `adapterSessionId` update the managed-sessions gate.
   * Events from other clients (e.g. `'codex'`, `'gemini'`) are ignored
   * unconditionally — their adapter sessions must not suppress Claude Code hook
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
   * Receive a raw statusline payload and forward it to `client.usage.ingest`
   * when an account identity can be resolved.
   *
   * Identity resolution proceeds in two stages and is cached per `session_id`
   * to avoid repeated bus lookups within the same turn.  The cache is cleared
   * on `account.activate` events for Claude Code, so an account switch between
   * turns causes the next statusline event to re-resolve identity.
   *
   * **Primary — session-based identity:**
   * 1. Extract `session_id` from the raw payload; return early when absent.
   * 2. Look up the session via {@link SessionStorageSubjects.getByAdapterSessionId}
   *    using `requestOptional` so a missing storage handler (e.g. in early boot
   *    or test isolation) is treated as a skip rather than an error.
   * 3. Read `clientAccountId` and the stored identifiers from the session.
   *
   * **Fallback — active account identity from `ClientRuntimeService`:**
   * When the session lookup does not yield a linked account (no handler, null
   * session, or missing `clientAccountId`), the service queries
   * `client.account.getActive` for `clientId === 'claude-code'`.  This covers
   * standalone Claude Code processes where no Makaio session exists but the
   * account-manager has already signalled the active identity via
   * `client.account.activate`.
   *
   * When neither stage resolves an identity the method returns early and the
   * raw event remains observable on `client:claude-code.statusline.received`.
   * @param raw - Raw statusline payload delivered on
   *   `client:claude-code.statusline.received`
   */
  private async handleStatuslineReceived(raw: Parameters<typeof normalizeClaudeCodeStatusline>[0]): Promise<void> {
    const adapterSessionId = raw.session_id;
    if (!adapterSessionId) return;
    const cacheEpoch = this.sessionIdentityCacheEpoch;

    // 1. Check session identity cache (pinned on first resolution).
    let identity: StatuslineIdentityContext | null = this.sessionIdentityCache.get(adapterSessionId) ?? null;

    // 2. Primary path: resolve identity from a linked Makaio session.
    if (!identity) {
      const sessionResult = await this.bus.requestOptional(SessionStorageSubjects.getByAdapterSessionId, {
        adapterSessionId,
      });
      if (sessionResult.handled && sessionResult.data.session) {
        identity = resolveIdentityFromSession(sessionResult.data.session);
      }
    }

    // 3. Fallback: use the active account identity signalled by the account-manager.
    //    This covers standalone Claude Code (no session exists yet or no storage
    //    handler is registered).
    if (!identity) {
      const activeResult = await this.bus.requestOptional(ClientSubjects.account.getActive, {
        clientId: CLIENT_ID,
      });
      if (activeResult.handled && activeResult.data.identity) {
        identity = activeResult.data.identity;
      }
    }

    // Pin identity for this session so future account switches don't affect attribution.
    // Concurrent statusline events may resolve in either order; once one handler
    // pins an identity, all in-flight handlers must use that pinned value.
    if (identity && cacheEpoch === this.sessionIdentityCacheEpoch) {
      const cachedIdentity = this.sessionIdentityCache.get(adapterSessionId);
      if (cachedIdentity) {
        identity = cachedIdentity;
      } else {
        if (this.sessionIdentityCache.size >= SESSION_IDENTITY_CACHE_CAP) {
          const oldest = this.sessionIdentityCache.keys().next().value;
          if (oldest !== undefined) {
            this.sessionIdentityCache.delete(oldest);
          }
        }
        this.sessionIdentityCache.set(adapterSessionId, identity);
      }
    }

    if (!identity) return;

    const normalized = normalizeClaudeCodeStatusline(raw, identity);
    if (!normalized) return;

    await this.bus.requestOptional(ClientSubjects.usage.ingest, normalized);
  }

  /**
   * Translate a raw hook event into normalized `client.session.*` emissions.
   *
   * Unknown / Claude-specific events produce no emission and are silently
   * ignored. The raw event is always available on `client:claude-code.*` for
   * consumers that need Claude-native detail.
   *
   * A single hook may normalize into multiple events (e.g. `UserPromptSubmit`
   * yields `turn.started` followed by `userPrompt.submitted`); they are
   * emitted sequentially in normalizer order.
   * @param raw - Raw hook payload delivered on `client:claude-code.hook.received`
   */
  private async handleHookReceived(raw: Parameters<typeof normalizeClaudeCodeHook>[0]): Promise<void> {
    for (const normalized of normalizeClaudeCodeHook(raw, this.machineId)) {
      await this.emitNormalizedEvent(normalized);
    }
  }

  /**
   * Emit a single normalized hook event on its global `client.session.*`
   * subject.
   *
   * `client.session.started` is suppressed when the `adapterSessionId` from
   * the hook payload is already known to be owned by an adapter-managed runtime
   * (see {@link handleRuntimeStarted}).  All other events — including
   * `turn.started` and `turn.completed` — are forwarded unconditionally: tool
   * and turn events have no adapter-path equivalent.
   * @param normalized - Normalized event produced by {@link normalizeClaudeCodeHook}
   */
  private async emitNormalizedEvent(normalized: ClaudeCodeNormalizedEvent): Promise<void> {
    switch (normalized.subject) {
      case ClientSubjects.session.started:
        if (
          normalized.payload.adapterSessionId !== undefined &&
          this.managedAdapterSessionIds.has(normalized.payload.adapterSessionId)
        ) {
          // The adapter path already owns this session's client.session.started
          // emission.  Suppress the native-hook duplicate so downstream
          // consumers receive exactly one started event per session.
          break;
        }
        await this.bus.emit(ClientSubjects.session.started, normalized.payload);
        break;
      case ClientSubjects.session.userPrompt.submitted:
        await this.bus.emit(ClientSubjects.session.userPrompt.submitted, normalized.payload);
        break;
      case ClientSubjects.session.turn.started:
        await this.bus.emit(ClientSubjects.session.turn.started, normalized.payload);
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
}

/**
 * Fail fast when the normalizer grows a new subject but service emission has
 * not been updated to preserve the normalized-event contract.
 * @param event - Normalized event whose subject is not emitted above
 */
function throwUnhandledNormalizedEvent(event: { readonly subject: { readonly subject: string } }): never {
  const subject = event.subject.subject;
  throw new Error(`Unhandled normalized Claude Code hook subject: ${subject}`);
}

/**
 * Return true when `client.resolveBinary` only failed because no Claude Code
 * executable was found. Config/wiring reads can still use Claude Code's default
 * settings path in that case; other resolution failures indicate corrupted
 * managed state or service errors and should propagate.
 * @param error - Error thrown by the bus request
 * @returns True when the error is the global-binary fallback miss
 */
function isResolveBinaryMissingGlobalBinary(error: unknown): boolean {
  if (!(error instanceof RequestError)) {
    return false;
  }
  return error.subject?.endsWith('resolveBinary') === true && error.cause instanceof BinaryNotFoundError;
}

/**
 * Extract a {@link StatuslineIdentityContext} from a session record.
 *
 * Reads the `clientAccountId` field and parses the `identifiers` array from
 * `lastClientIdentityObservation.payload.identifiers`.  Returns `null` when
 * either is absent or when the stored identifiers cannot be parsed.
 * @param session - Session record returned by the storage layer
 * @returns Resolved identity context, or `null` when insufficient evidence
 */
// Structural param type is intentional — this private helper accepts the
// subset of session fields it needs rather than coupling to a storage entity.
function resolveIdentityFromSession(session: {
  clientAccountId?: string;
  lastClientIdentityObservation?: { payload: Record<string, unknown> };
}): StatuslineIdentityContext | null {
  const clientAccountId = session.clientAccountId;
  if (!clientAccountId) {
    return null;
  }

  const rawIdentifiers = session.lastClientIdentityObservation?.payload['identifiers'];
  if (!Array.isArray(rawIdentifiers) || rawIdentifiers.length === 0) {
    return null;
  }

  let identifiers;
  try {
    identifiers = z.array(ClientAccountIdentifierSchema).min(1).parse(rawIdentifiers);
  } catch {
    return null;
  }

  const displayLabel = session.lastClientIdentityObservation?.payload['displayLabel'];

  return {
    clientAccountId,
    identifiers,
    displayLabel: typeof displayLabel === 'string' && displayLabel.trim().length > 0 ? displayLabel.trim() : undefined,
  };
}
