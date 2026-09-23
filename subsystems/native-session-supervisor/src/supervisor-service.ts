/**
 * Supervisor service.
 *
 * Implements the runtime owner for supervised native process runtimes.
 * Handles `launch`, `attach`, `stop`, and `status` bus requests by
 * coordinating between the {@link RuntimeRegistry} (persistent metadata) and
 * {@link PtyRuntime} (process management).
 * @packageDocumentation
 */
import { randomUUID } from 'node:crypto';
import { BaseService } from '@makaio/service-base';
import type { IMakaioBus } from '@makaio/bus-core';
import type { BaseMessageContext, ContextForSubjectDefinition } from '@makaio/core';
import { NativeSessionSupervisorSubjects } from '@makaio/contracts/native-session-supervisor';
import type { NativeSupervisorAttachRequest } from '@makaio/contracts/native-session-supervisor';
import { ClientSubjects } from '@makaio/contracts';
import { RuntimeRegistry } from './runtime-registry.js';
import type { SupervisorRuntime } from './types.js';
import { toSnapshot } from './runtime-snapshot.js';
import { PtyRuntime } from './pty/pty-runtime.js';
import { LazyNodePtyBackend } from './lazy-node-pty-backend.js';
import { TerminalAttachmentRegistry } from './terminal-attachment-registry.js';
import type { PtyExitEvent, PtyOutputEvent } from './pty/types.js';

export { LazyNodePtyBackend } from './lazy-node-pty-backend.js';

// Public types

/**
 * Handlers passed by the service to the {@link PtyRuntimeFactory} when
 * building a {@link PtyRuntime}.
 */
export interface PtyRuntimeHandlers {
  /**
   * Called when a PTY session emits output.
   * @param evt - Output event.
   */
  onOutput: (evt: PtyOutputEvent) => void;
  /**
   * Called when a PTY process terminates.
   * @param evt - Exit event.
   */
  onExit: (evt: PtyExitEvent) => void;
}

/**
 * Factory function that constructs a {@link PtyRuntime} wired to the provided
 * handlers.
 *
 * The service always calls this factory, passing its own `onExit` handler, so
 * natural PTY exits are always reflected in the registry regardless of which
 * backend is in use.
 */
export type PtyRuntimeFactory = (handlers: PtyRuntimeHandlers) => PtyRuntime;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Named authenticated peer permitted to control locally supervised PTYs. */
const LOCAL_CLI_PEER_KIND = 'makaio-cli-local';
/** Trusted peer claim assigned only by an unauthenticated loopback listener. */
const LOOPBACK_PEER_KIND = 'makaio-loopback';

/**
 * Determine whether a request may control a supervised process.
 *
 * Direct in-process calls retain their existing local-origin authority. CLI
 * requests crossing the local WebSocket bus must authenticate as the named
 * local CLI peer registered by the host composition root.
 * @param ctx - Trusted request metadata supplied by the bus dispatch path.
 * @returns Whether the caller may launch, stop, or control a terminal attachment.
 */
function isAuthorizedSupervisorControl(ctx: Pick<BaseMessageContext, 'origin' | 'transport'>): boolean {
  const peer = ctx.transport?.peer;
  return (
    ctx.origin.local ||
    (peer?.authenticated === true && peer.kind === LOCAL_CLI_PEER_KIND) ||
    (peer?.authenticated === false && peer.kind === LOOPBACK_PEER_KIND && ctx.transport?.connectionId !== undefined)
  );
}

/**
 * Build the environment passed to a supervised process.
 * @param sessionConfigEnv - Request and session-config environment values.
 * @param supervisorSessionId - Supervisor-assigned runtime identity.
 * @returns Environment for the supervised process.
 */
function createSupervisorLaunchEnv(
  sessionConfigEnv: Record<string, string> | undefined,
  supervisorSessionId: string,
): Record<string, string> {
  return {
    ...sessionConfigEnv,
    // Correlation identifier for the supervised runtime; not an authentication token.
    MAKAIO_SUPERVISOR_SESSION_ID: supervisorSessionId,
  };
}

/**
 * Default production {@link PtyRuntimeFactory} backed by lazy `node-pty`.
 * @param handlers - Output and exit callbacks wired by the supervisor service.
 * @returns A new `PtyRuntime` ready to be initialised.
 */
const defaultPtyRuntimeFactory: PtyRuntimeFactory = (handlers) => new PtyRuntime(new LazyNodePtyBackend(), handlers);

// ---------------------------------------------------------------------------
// SupervisorService
// ---------------------------------------------------------------------------

/**
 * Supervisor service responsible for the lifecycle of supervised native
 * process runtimes.
 *
 * The service is the orchestration layer between the bus API
 * (`NativeSessionSupervisorSubjects`), the persistent metadata store
 * (`RuntimeRegistry`), and the active PTY process manager (`PtyRuntime`).
 *
 * Handlers:
 * - `launch` — spawns a new PTY process and registers it in the registry.
 * - `attach` — resolves any locator to a `supervisorSessionId` and reports
 *   attachment capability for the active PTY session.
 * - `stop` — kills the PTY process and marks the registry entry as `stopped`.
 * - `status` — returns snapshots for one or all registered runtimes.
 */
export class SupervisorService extends BaseService {
  private readonly registry: RuntimeRegistry;
  private readonly ptyRuntime: PtyRuntime;
  private readonly pendingExits = new Map<string, PtyExitEvent>();
  private readonly sessionConfigBindings = new Map<string, { clientId: string; leaseId: string }>();
  private readonly terminalAttachments: TerminalAttachmentRegistry;
  #destroyed = false;

  /**
   * @param bus - Bus instance used for registering handlers and emitting events.
   * @param createPtyRuntime - Optional factory for constructing the PTY runtime.
   *   The factory receives the service's own output and exit handlers, ensuring
   *   that natural PTY exits always update the registry. Defaults to a
   *   lazily loaded `NodePtyBackend` suitable for production Node.js hosts.
   */
  public constructor(bus: IMakaioBus, createPtyRuntime?: PtyRuntimeFactory) {
    super(bus);
    this.registry = new RuntimeRegistry(bus);
    const factory = createPtyRuntime ?? defaultPtyRuntimeFactory;
    this.ptyRuntime = factory({
      onOutput: (evt) => {
        this.terminalAttachments?.routeOutput(evt);
      },
      onExit: (evt) => {
        void this._handlePtyExit(evt).catch((error: unknown) => {
          const errorName = error instanceof Error ? error.name : 'UnknownError';
          console.error('[SupervisorService] PTY exit finalization failed', {
            supervisorSessionId: evt.supervisorSessionId,
            errorName,
          });
        });
      },
    });
    this.terminalAttachments = new TerminalAttachmentRegistry(bus, this.ptyRuntime);
  }

  /**
   * Initialize the service.
   *
   * Registers bus handlers for all supervisor subjects and hydrates the
   * registry from persistent storage. The storage handlers must be registered
   * (via `storage.registerHandlers` in the package manifest) before this is
   * called.
   */
  protected override async onInit(): Promise<void> {
    this.ptyRuntime.init();
    await this.registry.loadFromStorage();
    await this._markHydratedRunningRuntimesUnknown();

    this.registerHandler(NativeSessionSupervisorSubjects.launch, (ctx) => {
      if (!isAuthorizedSupervisorControl(ctx))
        throw new Error('Unauthorized: supervisor.launch requires local CLI control');
      return this._handleLaunch(ctx);
    });
    this.registerHandler(NativeSessionSupervisorSubjects.attach, (ctx) => this._handleAttach(ctx));
    this.registerHandler(NativeSessionSupervisorSubjects.terminal.open, (ctx) => {
      if (!isAuthorizedSupervisorControl(ctx))
        throw new Error('Unauthorized: supervisor.terminal.open requires local CLI control');
      ctx.setResult(
        this.terminalAttachments.open(
          ctx.payload.attachmentId,
          this._resolveRunningRuntime(ctx.payload.locator),
          ctx.transport?.transportName,
          ctx.transport?.connectionId,
        ),
      );
    });
    this.registerHandler(NativeSessionSupervisorSubjects.terminal.input, (ctx) => {
      if (!isAuthorizedSupervisorControl(ctx))
        throw new Error('Unauthorized: supervisor.terminal.input requires local CLI control');
      this.terminalAttachments.write(
        ctx.payload.attachmentId,
        ctx.payload.data,
        ctx.transport?.transportName,
        ctx.transport?.connectionId,
      );
      ctx.setResult({ success: true });
    });
    this.registerHandler(NativeSessionSupervisorSubjects.terminal.resize, (ctx) => {
      if (!isAuthorizedSupervisorControl(ctx))
        throw new Error('Unauthorized: supervisor.terminal.resize requires local CLI control');
      this.terminalAttachments.resize(
        ctx.payload.attachmentId,
        ctx.payload.cols,
        ctx.payload.rows,
        ctx.transport?.transportName,
        ctx.transport?.connectionId,
      );
      ctx.setResult({ success: true });
    });
    this.registerHandler(NativeSessionSupervisorSubjects.terminal.close, (ctx) => {
      if (!isAuthorizedSupervisorControl(ctx))
        throw new Error('Unauthorized: supervisor.terminal.close requires local CLI control');
      ctx.setResult({
        success: this.terminalAttachments.close(
          ctx.payload.attachmentId,
          ctx.transport?.transportName,
          ctx.transport?.connectionId,
        ),
      });
    });
    this.registerHandler(NativeSessionSupervisorSubjects.stop, (ctx) => {
      if (!isAuthorizedSupervisorControl(ctx))
        throw new Error('Unauthorized: supervisor.stop requires local CLI control');
      return this._handleStop(ctx);
    });
    this.registerHandler(NativeSessionSupervisorSubjects.status, (ctx) => this._handleStatus(ctx));
  }

  /** Tear down the PTY runtime and release every bound config lease. */
  protected override async onDestroy(): Promise<void> {
    this.#destroyed = true;
    const errors: Error[] = [];
    try {
      await this.ptyRuntime.destroy();
    } catch {
      errors.push(new Error('PTY runtime teardown failed'));
    }
    this.pendingExits.clear();
    this.terminalAttachments.clear();

    const bindings = [...this.sessionConfigBindings.keys()];
    const cleanupResults = await Promise.allSettled(bindings.map((id) => this.destroySessionConfig(id)));
    for (let index = 0; index < cleanupResults.length; index += 1) {
      if (cleanupResults[index]?.status === 'rejected') {
        errors.push(new Error(`Config lease cleanup failed for supervised runtime '${bindings[index]}'`));
      }
    }

    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Native session supervisor teardown failed');
    }
  }

  /**
   * Returns the registry instance.
   * @returns The runtime registry.
   */
  public getRegistry(): RuntimeRegistry {
    return this.registry;
  }

  // Private handler implementations

  /**
   * Handle a `launch` request: spawn a PTY process and register the runtime.
   * @param ctx - Bus handler context carrying the launch request payload.
   */
  private async _handleLaunch(
    ctx: ContextForSubjectDefinition<typeof NativeSessionSupervisorSubjects.launch>,
  ): Promise<void> {
    const { clientId, cwd, command, args, env, sessionId, clientProfileName, adapterSessionId, metadata } = ctx.payload;

    const supervisorSessionId = randomUUID();
    const startedAt = Date.now();
    const sessionConfig = await this.prepareSessionConfig({
      supervisorSessionId,
      clientId,
      sessionId,
      profileName: clientProfileName,
      env,
    });

    let pid: number;
    try {
      ({ pid } = await this.ptyRuntime.spawn({
        supervisorSessionId,
        file: command,
        args,
        options: {
          cwd,
          env: createSupervisorLaunchEnv(sessionConfig.env, supervisorSessionId),
          inheritEnvironment: true,
        },
      }));
    } catch (error) {
      try {
        await this.destroySessionConfig(supervisorSessionId);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Native runtime spawn and config cleanup both failed');
      }
      throw error;
    }

    try {
      await this.registry.register({
        supervisorSessionId,
        clientId,
        pid,
        cwd,
        command,
        args,
        ...(sessionConfig.env !== undefined && { env: sessionConfig.env }),
        ...(sessionId !== undefined && { sessionId }),
        ...(adapterSessionId !== undefined && { adapterSessionId }),
        ...(metadata !== undefined && { metadata }),
        startedAt,
      });
    } catch (error) {
      this.ptyRuntime.kill(supervisorSessionId, 'SIGTERM');
      try {
        await this.destroySessionConfig(supervisorSessionId);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Runtime registration and config cleanup both failed');
      } finally {
        // Race note: a PTY exit event arriving after this delete would re-add to
        // pendingExits. This window is extremely narrow (kill is synchronous, exit
        // callback is async) and a leaked entry is harmless — it will be checked
        // and discarded on the next register() for an unrelated ID.
        this.pendingExits.delete(supervisorSessionId);
      }
      throw error;
    }

    // Register the supervisor as a persistent subscriber so the orphan-cleanup
    // loop does not reap the session. The supervisor owns the process lifecycle
    // and never disconnects — cleanup happens via explicit stop or exit events.
    this.ptyRuntime.connect(supervisorSessionId, null);

    const pendingExit = this.pendingExits.get(supervisorSessionId);
    if (pendingExit !== undefined) {
      this.pendingExits.delete(supervisorSessionId);
      await this._recordPtyExit(pendingExit);
    }

    // Best-effort runtime observation: notify the runtime registry that this
    // supervisor has spawned a client process. Fire-and-forget — failure must
    // never block the launch response.
    void this.bus
      .requestOptional(ClientSubjects.runtime.observe, {
        clientId,
        source: { layer: 'supervisor', producer: 'native-session-supervisor' },
        observedAt: Date.now(),
        supervisorSessionId,
        pid,
        ...(sessionId !== undefined && { sessionId }),
        ...(adapterSessionId !== undefined && { adapterSessionId }),
      })
      .catch(() => {
        // Best-effort: runtime observation must not block launch.
      });

    ctx.setResult({ supervisorSessionId, pid });
  }

  /**
   * Handle an `attach` request: resolve the locator and report attachment state.
   * @param ctx - Bus handler context carrying the attach request payload.
   */
  private _handleAttach(ctx: ContextForSubjectDefinition<typeof NativeSessionSupervisorSubjects.attach>): void {
    const request = ctx.payload;

    let supervisorSessionId: string;

    if ('supervisorSessionId' in request) {
      supervisorSessionId = request.supervisorSessionId;
    } else if ('sessionId' in request) {
      const runtime = this.registry.getBySessionId(request.sessionId);
      if (runtime === undefined) {
        ctx.setResult({ success: false });
        return;
      }
      supervisorSessionId = runtime.supervisorSessionId;
    } else {
      const runtime = this.registry.getByAdapterSessionId(request.adapterSessionId);
      if (runtime === undefined) {
        ctx.setResult({ success: false });
        return;
      }
      supervisorSessionId = runtime.supervisorSessionId;
    }

    const runtime = this.registry.getBySupervisorId(supervisorSessionId);
    if (runtime === undefined || runtime.status !== 'running') {
      ctx.setResult({ success: false });
      return;
    }

    const ptyStatus = this.ptyRuntime.getSessionStatus(supervisorSessionId);
    ctx.setResult({
      success: true,
      supervisorSessionId,
      ...(runtime.pid !== null && { pid: runtime.pid }),
      terminalAttachment: { canAttach: ptyStatus !== null },
    });
  }

  /**
   * Resolve a locator to a running in-memory PTY runtime.
   * @param request - Exactly one runtime locator.
   * @returns The active runtime or `null` when it has no local PTY.
   */
  private _resolveRunningRuntime(request: NativeSupervisorAttachRequest): SupervisorRuntime | null {
    const supervisorSessionId =
      'supervisorSessionId' in request
        ? request.supervisorSessionId
        : 'sessionId' in request
          ? this.registry.getBySessionId(request.sessionId)?.supervisorSessionId
          : this.registry.getByAdapterSessionId(request.adapterSessionId)?.supervisorSessionId;
    const runtime = this.registry.getBySupervisorId(supervisorSessionId ?? '');
    if (runtime === undefined || runtime.status !== 'running') return null;
    return this.ptyRuntime.getSessionStatus(runtime.supervisorSessionId) === null ? null : runtime;
  }

  /**
   * Handle a `stop` request: kill the PTY process and mark the runtime stopped.
   *
   * Returns `success: false` when no in-memory PTY session exists for the ID.
   * This can happen for hydrated runtimes whose status is `'unknown'` — they
   * were loaded from storage after a supervisor restart and never had an active
   * PTY in this process. Allowing a successful `stop` response in that case
   * would give callers misleading feedback.
   * @param ctx - Bus handler context carrying the stop request payload.
   */
  private async _handleStop(
    ctx: ContextForSubjectDefinition<typeof NativeSessionSupervisorSubjects.stop>,
  ): Promise<void> {
    const { supervisorSessionId, signal } = ctx.payload;

    const runtime = this.registry.getBySupervisorId(supervisorSessionId);
    if (runtime === undefined) {
      ctx.setResult({ success: false });
      return;
    }

    // Returns false when no in-memory PTY session exists (e.g. hydrated
    // 'unknown' runtimes that were never spawned in this process lifetime).
    const killed = this.ptyRuntime.kill(supervisorSessionId, signal ?? 'SIGTERM');
    if (!killed) {
      ctx.setResult({ success: false });
      return;
    }

    await this.registry.update({
      supervisorSessionId,
      status: 'stopped',
      pid: null,
      stoppedAt: Date.now(),
    });
    await this.destroySessionConfig(supervisorSessionId);

    ctx.setResult({ success: true });
  }

  /**
   * Handle a `status` request: return snapshots for matching runtimes.
   *
   * The schema guarantees exactly zero or one locator field is present.
   * @param ctx - Bus handler context carrying the status request payload.
   */
  private _handleStatus(ctx: ContextForSubjectDefinition<typeof NativeSessionSupervisorSubjects.status>): void {
    const request = ctx.payload;

    if ('supervisorSessionId' in request) {
      const runtime = this.registry.getBySupervisorId(request.supervisorSessionId);
      ctx.setResult({ runtimes: runtime !== undefined ? [toSnapshot(runtime)] : [] });
      return;
    }

    if ('sessionId' in request) {
      const runtime = this.registry.getBySessionId(request.sessionId);
      ctx.setResult({ runtimes: runtime !== undefined ? [toSnapshot(runtime)] : [] });
      return;
    }

    if ('adapterSessionId' in request) {
      const runtime = this.registry.getByAdapterSessionId(request.adapterSessionId);
      ctx.setResult({ runtimes: runtime !== undefined ? [toSnapshot(runtime)] : [] });
      return;
    }

    ctx.setResult({ runtimes: this.registry.getAll().map(toSnapshot) });
  }

  /**
   * Handle a PTY process exit event by marking the registry entry as `exited`.
   *
   * Exits arriving after `onDestroy()` are silently dropped: the registry and
   * bus may already be torn down, so processing them would be unsafe.
   * @param evt - Exit event carrying the supervisor session ID and exit code.
   */
  private async _handlePtyExit(evt: PtyExitEvent): Promise<void> {
    if (this.#destroyed) return;
    await this._recordPtyExit(evt);
  }

  /**
   * Record a PTY exit in the persistent registry.
   *
   * Exit events can arrive before launch registration finishes for very short
   * lived processes. Those events are retained and replayed once registration
   * succeeds. Explicit `stop` remains the terminal user-requested state; the
   * subsequent OS exit event only confirms the process is gone and must not
   * reclassify the runtime as a natural exit.
   * @param evt - Exit event carrying the supervisor session ID and exit code.
   */
  private async _recordPtyExit(evt: PtyExitEvent): Promise<void> {
    this.terminalAttachments.releaseRuntime(evt.supervisorSessionId);
    const runtime = this.registry.getBySupervisorId(evt.supervisorSessionId);
    if (runtime === undefined) {
      this.pendingExits.set(evt.supervisorSessionId, evt);
      return;
    }

    if (runtime.status === 'stopped') {
      return;
    }

    await this.registry.update({
      supervisorSessionId: evt.supervisorSessionId,
      status: 'exited',
      pid: null,
      stoppedAt: Date.now(),
    });
    await this.destroySessionConfig(evt.supervisorSessionId);
  }

  /**
   * Materialize session-scoped client config when the client config service is available.
   * @param options - Launch identity and environment fields.
   * @returns Environment to pass to the spawned process.
   */
  private async prepareSessionConfig(options: {
    supervisorSessionId: string;
    clientId: string;
    sessionId: string | undefined;
    profileName: string | undefined;
    env: Record<string, string> | undefined;
  }): Promise<{ env: Record<string, string> | undefined }> {
    const result = await this.bus.requestOptional(ClientSubjects.sessionConfig.create, {
      clientId: options.clientId,
      leaseId: options.supervisorSessionId,
      ...(options.sessionId !== undefined ? { ownerSessionId: options.sessionId } : {}),
      profileName: options.profileName,
    });

    if (!result.handled) {
      if (options.profileName !== undefined) {
        throw new Error('Client profile launch requires client.sessionConfig.create support');
      }
      return { env: options.env };
    }

    this.sessionConfigBindings.set(options.supervisorSessionId, {
      clientId: options.clientId,
      leaseId: options.supervisorSessionId,
    });
    return { env: { ...(options.env ?? {}), ...result.data.env } };
  }

  /**
   * Destroy materialized session config for a supervised runtime, if present.
   * @param supervisorSessionId - Supervisor runtime identity.
   */
  private async destroySessionConfig(supervisorSessionId: string): Promise<void> {
    const binding = this.sessionConfigBindings.get(supervisorSessionId);
    if (binding === undefined) {
      return;
    }
    try {
      const result = await this.bus.requestOptional(ClientSubjects.sessionConfig.destroy, {
        clientId: binding.clientId,
        leaseId: binding.leaseId,
      });
      if (!result.handled || !result.data.success) {
        throw new Error('Config lease cleanup was not handled successfully');
      }
    } catch {
      throw new Error(`Failed to release config lease for supervised runtime '${supervisorSessionId}'`);
    }
    if (this.sessionConfigBindings.get(supervisorSessionId) === binding) {
      this.sessionConfigBindings.delete(supervisorSessionId);
    }
  }

  /**
   * Reconcile persisted runtime metadata on service startup.
   *
   * The registry persists metadata, not PTY handles. After a supervisor process
   * restart, previously persisted `running` rows are no longer owned by the new
   * in-memory `PtyRuntime`, so the only honest state is `unknown` until a new
   * supervised runtime is launched.
   */
  private async _markHydratedRunningRuntimesUnknown(): Promise<void> {
    const runningRuntimes = this.registry.getByStatus('running');
    for (const runtime of runningRuntimes) {
      await this.registry.update({
        supervisorSessionId: runtime.supervisorSessionId,
        status: 'unknown',
        pid: null,
      });
    }
  }
}
