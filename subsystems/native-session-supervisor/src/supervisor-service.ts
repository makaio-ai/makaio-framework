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
import type { ContextForSubjectDefinition } from '@makaio/core';
import { NativeSessionSupervisorSubjects } from '@makaio/contracts/native-session-supervisor';
import type { SupervisorRuntimeSnapshot } from '@makaio/contracts/native-session-supervisor';
import { ClientSubjects } from '@makaio/contracts';
import { RuntimeRegistry } from './runtime-registry.js';
import type { SupervisorRuntime } from './types.js';
import { PtyRuntime } from './pty/pty-runtime.js';
import type { IPtyBackend, IPtyProcess, IPtySpawnOptions, PtyExitEvent, PtyOutputEvent } from './pty/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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

/**
 * Convert an in-memory {@link SupervisorRuntime} to a bus-safe
 * {@link SupervisorRuntimeSnapshot} for status responses.
 * @param runtime - Full in-memory runtime record.
 * @returns Snapshot suitable for bus transmission.
 */
function toSnapshot(runtime: SupervisorRuntime): SupervisorRuntimeSnapshot {
  return {
    supervisorSessionId: runtime.supervisorSessionId,
    clientId: runtime.clientId,
    pid: runtime.pid,
    status: runtime.status,
    cwd: runtime.cwd,
    ...(runtime.sessionId !== undefined && { sessionId: runtime.sessionId }),
    ...(runtime.adapterSessionId !== undefined && { adapterSessionId: runtime.adapterSessionId }),
    startedAt: runtime.startedAt,
    ...(runtime.stoppedAt !== undefined && { stoppedAt: runtime.stoppedAt }),
  };
}

/**
 * Lazy production backend that avoids loading the `node-pty` native addon
 * until a Node.js host actually spawns a PTY.
 */
export class LazyNodePtyBackend implements IPtyBackend {
  private backend: IPtyBackend | null = null;
  private backendPromise: Promise<IPtyBackend> | null = null;

  /**
   * @param createBackend - Lazy backend factory. Defaults to importing the native Node PTY backend.
   */
  public constructor(
    private readonly createBackend: () => Promise<IPtyBackend> = async () => {
      const { NodePtyBackend } = await import('./pty/node-pty-backend.js');
      return new NodePtyBackend();
    },
  ) {}

  /**
   * Spawn a PTY after resolving the native backend.
   * @param file - Executable path or name.
   * @param args - Argument list passed to the executable.
   * @param options - PTY spawn options.
   * @returns Spawned PTY process handle.
   */
  public async spawn(file: string, args: string[], options: IPtySpawnOptions): Promise<IPtyProcess> {
    const backend = await this.getBackend();
    return backend.spawn(file, args, options);
  }

  /**
   * Dispose the native backend when it has been loaded.
   */
  public async dispose(): Promise<void> {
    try {
      const backend = this.backend ?? (this.backendPromise ? await this.backendPromise : null);
      await backend?.dispose?.();
    } finally {
      this.backend = null;
      this.backendPromise = null;
    }
  }

  private async getBackend(): Promise<IPtyBackend> {
    if (this.backend !== null) {
      return this.backend;
    }

    this.backendPromise ??= this.createBackend().then((backend) => {
      this.backend = backend;
      return backend;
    });

    try {
      return await this.backendPromise;
    } catch (error) {
      this.backendPromise = null;
      throw error;
    }
  }
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
      onOutput: () => {
        /* output routing is handled by downstream consumers */
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
      if (!ctx.origin.local) throw new Error('Unauthorized: supervisor.launch requires a local-origin request');
      return this._handleLaunch(ctx);
    });
    this.registerHandler(NativeSessionSupervisorSubjects.attach, (ctx) => this._handleAttach(ctx));
    this.registerHandler(NativeSessionSupervisorSubjects.stop, (ctx) => {
      if (!ctx.origin.local) throw new Error('Unauthorized: supervisor.stop requires a local-origin request');
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

  // -------------------------------------------------------------------------
  // Private handler implementations
  // -------------------------------------------------------------------------

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
          ...(sessionConfig.env !== undefined && { env: sessionConfig.env }),
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
