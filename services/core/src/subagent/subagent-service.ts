import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { BaseService } from '@makaio/service-base';
import type { ExtractSubjectPayload } from '@makaio/core';
import {
  SubagentSubjects,
  SessionSubjects,
  AdapterSubjects,
  SubagentConfigSchema,
  DEFAULT_CONSTRAINTS,
  type SubagentConstraints,
  type SubagentConfig,
  SpawnSubagentRpcRequestSchema,
  type ExecuteSubagentResponse,
  type SubagentExecutionFailed,
} from '@makaio/contracts';
import { AdapterRuntimeSubjects } from '@makaio/services-core/adapter-runtime';
import type { ExecutionTarget } from '@makaio/services-core/execution-target';
import { ExecutionTargetSubjects } from '../execution-target/namespace.js';
import { SessionStorageSubjects } from '../session/storage/namespace.js';
import { activateProviderContext, buildProviderContext } from '@makaio/services-core/provider-context';
import { SubagentManager } from './manager/index.js';
import {
  handleGetStatusRpc,
  handleSpawnRpc,
  handleAwaitRpc,
  handleSendRpc,
  handleKillRpc,
  handleReportProgressRpc,
  handleRequestInputRpc,
  handleCompleteTaskRpc,
  handleListBySessionRpc,
  type RpcHandlerContext,
} from './rpc-handlers.js';

// Sentinel for in-memory fallback only — never persisted. Timestamps
// are module-init snapshots; they are not meaningful for sorting.
/**
 * Fallback execution target used when the ExecutionTargetService is not
 * registered (e.g. in headless runtimes without the execution-target package).
 */
const SUBAGENT_DEFAULT_LOCAL_TARGET: ExecutionTarget = {
  id: 'system:local',
  name: 'Local',
  description: 'Default local process execution',
  type: 'local',
  scope: 'default',
  enabled: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

/** Spawned event payload type inferred from schema */
type SpawnedPayload = ExtractSubjectPayload<typeof SubagentSubjects.spawned>;
type ExecuteSubagentPayload = ExtractSubjectPayload<typeof SubagentSubjects.execute>;
type ToChildPayload = ExtractSubjectPayload<typeof SubagentSubjects.toChild>;
type ChildSessionCreatePayload = ExtractSubjectPayload<typeof SessionSubjects.create>;

/**
 * Orchestrates subagent execution lifecycle.
 *
 * Owns SubagentManager and handles:
 * - Session creation on spawn
 * - Adapter startup on spawn
 * - Message routing (toChild \> child session)
 * - Cleanup on completion/cancellation
 */
export class SubagentService extends BaseService {
  /** Manager is now private - tools use RPCs to interact with state */
  private readonly manager: SubagentManager;

  /**
   * Creates a new SubagentService instance.
   * @param bus - The event bus for inter-service communication
   * @param constraints - Subagent execution constraints
   * @param machineId - Optional machine ID for adapter resolution
   */
  public constructor(
    bus: IMakaioBus = MakaioBus,
    constraints: SubagentConstraints = DEFAULT_CONSTRAINTS,
    private readonly machineId?: string,
  ) {
    super(bus);
    this.manager = new SubagentManager(constraints);
  }

  /**
   * Register bus handlers for subagent lifecycle management.
   */
  protected onInit(): void {
    // Listen for spawned events to trigger execution
    this.registerHandler(SubagentSubjects.spawned, async (ctx) => {
      // Fire-and-forget: don't block the spawner
      this.handleSpawned(ctx.payload).catch((err) => {
        console.error('[SubagentService] handleSpawned error:', err);
      });
    });

    // Handle execute RPC (for explicit execution requests)
    this.registerHandler(SubagentSubjects.execute, async (ctx) => {
      const result = await this.handleExecute(ctx.payload);
      ctx.setResult(result);
    });

    // Route toChild messages to child sessions
    this.registerHandler(SubagentSubjects.toChild, async (ctx) => {
      await this.handleToChild(ctx.payload);
    });

    // Clean up on completion
    this.registerHandler(SubagentSubjects.completed, (ctx) => {
      this.handleCompleted(ctx.payload.subagentId);
    });

    // Clean up on cancellation
    this.registerHandler(SubagentSubjects.cancelled, (ctx) => {
      this.handleCancelled(ctx.payload.subagentId);
    });

    // Detect dead child adapter processes
    this.registerHandler(AdapterSubjects.session.closed, (ctx) => {
      this.handleAdapterSessionClosed(ctx.payload.sessionId);
    });

    // Register state operation RPCs
    this.registerRpcHandlers();

    // Wire periodic hung-subagent sweep + completed-state cleanup
    this.wirePeriodicSweep();
  }

  /**
   * Wire periodic sweep and cleanup interval.
   * Uses addCleanup so interval is cleared on destroy().
   */
  private wirePeriodicSweep(): void {
    const { inactivityTimeoutMs, sweepIntervalMs } = this.manager.constraints;
    if (sweepIntervalMs <= 0) return;

    const sweepHandle = setInterval(() => {
      const swept = this.manager.sweepHung(inactivityTimeoutMs);
      if (swept > 0) {
        console.warn(`[SubagentService] Swept ${swept} hung subagent(s) due to inactivity`);
      }
      this.manager.cleanup();
    }, sweepIntervalMs);

    this.addCleanup(() => clearInterval(sweepHandle));
  }

  /**
   * Register RPC handlers for state operations.
   * Tools interact with subagent state through these RPCs.
   */
  private registerRpcHandlers(): void {
    const ctx: RpcHandlerContext = {
      manager: this.manager,
      bus: this.bus,
    };

    // getStatus RPC - query subagent state
    this.registerHandler(SubagentSubjects.getStatus, (busCtx) => {
      const result = handleGetStatusRpc(ctx, busCtx.payload);
      busCtx.setResult(result);
    });

    // spawn RPC - validates constraints, tracks, emits spawned
    this.registerHandler(SubagentSubjects.spawn, async (busCtx) => {
      const payload = SpawnSubagentRpcRequestSchema.parse(busCtx.payload);
      const result = await handleSpawnRpc(ctx, payload);
      busCtx.setResult(result);
    });

    // await RPC - waits for terminal state or timeout
    this.registerHandler(SubagentSubjects.await, async (busCtx) => {
      const result = await handleAwaitRpc(ctx, busCtx.payload);
      busCtx.setResult(result);
    });

    // send RPC - send message to subagent, optionally resolve pending
    this.registerHandler(SubagentSubjects.send, async (busCtx) => {
      const result = await handleSendRpc(ctx, busCtx.payload);
      busCtx.setResult(result);
    });

    // kill RPC - terminate subagent
    this.registerHandler(SubagentSubjects.kill, async (busCtx) => {
      const result = await handleKillRpc(ctx, busCtx.payload);
      busCtx.setResult(result);
    });

    // reportProgress RPC - child reports progress
    this.registerHandler(SubagentSubjects.reportProgress, async (busCtx) => {
      const result = await handleReportProgressRpc(ctx, busCtx.payload);
      busCtx.setResult(result);
    });

    // requestInput RPC - child requests input from parent
    this.registerHandler(SubagentSubjects.requestInput, async (busCtx) => {
      const result = await handleRequestInputRpc(ctx, busCtx.payload);
      busCtx.setResult(result);
    });

    // completeTask RPC - child signals completion
    this.registerHandler(SubagentSubjects.completeTask, async (busCtx) => {
      const result = await handleCompleteTaskRpc(ctx, busCtx.payload);
      busCtx.setResult(result);
    });

    // listBySession RPC - returns non-terminal subagents for a parent session
    this.registerHandler(SubagentSubjects.listBySession, (busCtx) => {
      const result = handleListBySessionRpc(ctx, busCtx.payload);
      busCtx.setResult(result);
    });
  }

  /**
   * Handle spawned event - create session and start agent.
   * @param payload - Spawned event payload
   * @returns Error message on failure, undefined on success
   */
  private async handleSpawned(payload: SpawnedPayload): Promise<string | undefined> {
    const { subagentId, parentSessionId, task, spawningToolCallId } = payload;
    const config = SubagentConfigSchema.parse({ ...payload.config, task });
    const adapterName = config.adapterName?.trim();

    if (!adapterName) {
      return this.failSpawn(
        subagentId,
        parentSessionId,
        'adapter_start',
        'Subagent spawn requires a non-empty adapterName',
      );
    }

    if (!this.manager.get(subagentId)) {
      this.manager.track({
        subagentId,
        parentSessionId,
        config,
        depth: payload.depth ?? 1,
      });
    }

    let resolvedExecutionTargetId: string | undefined;
    let resolutionParams: Awaited<ReturnType<typeof this.buildExecutionTargetResolutionParams>>;
    try {
      resolutionParams = await this.buildExecutionTargetResolutionParams(parentSessionId, config.executionTargetId);
      const resolveResult = await this.bus.requestOptional(ExecutionTargetSubjects.resolve, resolutionParams);
      let executionTarget: ExecutionTarget;
      if (resolveResult.handled) {
        executionTarget = resolveResult.data.executionTarget;
      } else if (resolutionParams.executionTargetId != null) {
        // Explicit target requested but no resolver is registered — throwing
        // here surfaces the misconfiguration rather than silently ignoring
        // the caller's intent and running locally.
        throw new Error(
          `Execution target resolver unavailable for explicit target '${resolutionParams.executionTargetId}'`,
        );
      } else {
        executionTarget = SUBAGENT_DEFAULT_LOCAL_TARGET;
      }

      if (executionTarget.type !== 'local') {
        return this.failSpawn(
          subagentId,
          parentSessionId,
          'adapter_start',
          `Execution target type '${executionTarget.type}' is not yet supported for subagents`,
        );
      }

      // Persist only explicit or inherited target IDs. A missing ID means the
      // resolver returned the framework default local host, which should not be
      // stamped onto child sessions.
      resolvedExecutionTargetId = resolutionParams.executionTargetId ?? undefined;
    } catch (err) {
      return this.failSpawn(subagentId, parentSessionId, 'adapter_start', err);
    }

    let sessionId: string;
    try {
      sessionId = await this.createChildSessionForSpawn(
        subagentId,
        parentSessionId,
        config,
        resolvedExecutionTargetId,
        resolutionParams,
        spawningToolCallId,
      );
    } catch (err) {
      return this.failSpawn(subagentId, parentSessionId, 'session_create', err);
    }

    try {
      await this.startAdapterForSubagent(adapterName, config, sessionId, task);
    } catch (err) {
      return this.failSpawn(subagentId, parentSessionId, 'adapter_start', err);
    }

    return undefined;
  }

  /**
   * Creates the child session and updates tracked subagent state.
   * @param subagentId - Subagent identifier
   * @param parentSessionId - Parent session identifier
   * @param config - Parsed subagent config
   * @param executionTargetId - Resolved execution target ID
   * @param resolutionParams - Framework execution-target fallback fields
   * @param spawningToolCallId - Tool call ID that triggered the spawn, if available
   * @returns Created child session ID
   */
  private async createChildSessionForSpawn(
    subagentId: string,
    parentSessionId: string,
    config: SubagentConfig,
    executionTargetId: string | undefined,
    resolutionParams: Awaited<ReturnType<typeof this.buildExecutionTargetResolutionParams>>,
    spawningToolCallId: string | undefined,
  ): Promise<string> {
    const { sessionId } = await this.bus.request(
      SessionSubjects.create,
      this.buildChildSessionCreatePayload(parentSessionId, config, executionTargetId, spawningToolCallId),
    );
    this.manager.setChildSessionId(subagentId, sessionId);
    return sessionId;
  }

  /**
   * Starts the adapter agent in the newly created child session.
   * @param adapterName - Adapter type name
   * @param config - Parsed subagent config
   * @param sessionId - Child session ID
   * @param task - Initial task message
   * @returns Resolves when adapter start succeeds
   * @throws Error when adapter startup fails
   */
  private async startAdapterForSubagent(
    adapterName: string,
    config: SubagentConfig,
    sessionId: string,
    task: string,
  ): Promise<void> {
    // Resolve to persisted UUID adapterId before routing startAgent.
    // adapterName is user-facing type ID and may not match runtime instance identity.
    const { adapterId } = await this.bus.request(AdapterRuntimeSubjects.resolveId, {
      adapterName,
      ...(this.machineId !== undefined && { machineId: this.machineId }),
    });
    const providerContext = config.providerConfigId
      ? await buildProviderContext(this.bus, config.providerConfigId)
      : undefined;
    if (providerContext !== undefined) {
      await activateProviderContext(this.bus, providerContext);
    }
    const result = await this.bus.request(AdapterSubjects.startAgent, {
      adapterId,
      role: 'lead',
      ...(providerContext !== undefined && { providerContext }),
      sessionId,
      initialMessage: task,
      model: config.model,
      systemPrompt: config.systemPrompt,
      allowedTools: config.tools,
      disallowedTools: config.disallowedTools,
      ...(config.harnessId !== undefined && { harnessId: config.harnessId }),
    });

    // Treat malformed or falsy responses as adapter-start failures.
    if (!result || result.success !== true) {
      throw new Error(result?.message ?? 'Adapter start failed');
    }
  }

  /**
   * Marks subagent spawn as failed and emits the lifecycle failure event.
   * @param subagentId - Subagent identifier
   * @param parentSessionId - Parent session identifier
   * @param phase - Spawn phase where failure occurred
   * @param reason - Error object or message
   * @returns Normalized error message
   */
  private async failSpawn(
    subagentId: string,
    parentSessionId: string,
    phase: SubagentExecutionFailed['phase'],
    reason: unknown,
  ): Promise<string> {
    const error = reason instanceof Error ? reason.message : String(reason);
    this.manager.markFailed(subagentId, error);
    await this.emitExecutionFailed(subagentId, parentSessionId, phase, reason);
    return error;
  }

  /**
   * Build execution-target resolution parameters for subagent spawn.
   *
   * Priority:
   * 1. Explicit subagent `executionTargetId`
   * 2. Parent session stamped target + context
   * @param parentSessionId - Parent session used as fallback context.
   * @param executionTargetId - Optional explicit target override from subagent config.
   * @returns Resolution parameters for `ExecutionTargetSubjects.resolve`.
   */
  private async buildExecutionTargetResolutionParams(
    parentSessionId: string,
    executionTargetId?: string,
  ): Promise<{
    executionTargetId?: string;
  }> {
    if (executionTargetId !== undefined) {
      return { executionTargetId };
    }

    const { session: parentSession } = await this.bus.request(SessionStorageSubjects.get, {
      sessionId: parentSessionId,
    });
    if (!parentSession) {
      throw new Error(`Parent session not found: ${parentSessionId}`);
    }

    return {
      executionTargetId: parentSession.executionTargetId,
    };
  }

  /**
   * Build child session creation payload from subagent config.
   *
   * `parentSessionId` always records the session graph relation. The separate
   * contextInheritance field controls whether parent conversation history is
   * assembled for the child's first turn.
   * @param parentSessionId - Parent session identifier from the spawn request
   * @param config - Parsed subagent config
   * @param executionTargetId - Resolved execution target to stamp on child session
   * @param spawningToolCallId - Tool call ID that triggered the spawn, if available
   * @returns Session.create payload for the child session
   */
  private buildChildSessionCreatePayload(
    parentSessionId: string,
    config: SubagentConfig,
    executionTargetId: string | undefined,
    spawningToolCallId: string | undefined,
  ): ChildSessionCreatePayload {
    return {
      branchKind: 'subagent' as const,
      parentSessionId,
      contextInheritance: config.contextMode === 'fork' ? 'parent-history' : 'none',
      ...(executionTargetId !== undefined && { executionTargetId }),
      ...(spawningToolCallId !== undefined && { spawningToolCallId }),
    };
  }

  private async handleExecute(payload: ExecuteSubagentPayload): Promise<ExecuteSubagentResponse> {
    const config = SubagentConfigSchema.parse({ ...payload.config, task: payload.task });
    // First track the subagent in manager (normally done by spawn tool, but execute RPC bypasses that)
    this.manager.track({
      subagentId: payload.subagentId,
      parentSessionId: payload.parentSessionId,
      config,
      depth: payload.depth,
    });

    const error = await this.handleSpawned({
      subagentId: payload.subagentId,
      parentSessionId: payload.parentSessionId,
      task: payload.task,
      config,
      depth: payload.depth,
    });

    if (error) {
      return { success: false, error };
    }
    return { success: true };
  }

  /**
   * Route a message from parent to child subagent session.
   * @param payload - Message routing payload
   */
  private async handleToChild(payload: ToChildPayload): Promise<void> {
    const { subagentId, content } = payload;

    const tracked = this.manager.get(subagentId);
    if (!tracked) {
      console.warn(`[SubagentService] No subagent found: ${subagentId}`);
      return;
    }

    if (!tracked.childSessionId) {
      console.warn(`[SubagentService] No child session for subagent: ${subagentId}`);
      return;
    }

    try {
      await this.bus.request(SessionSubjects.sendMessage, {
        sessionId: tracked.childSessionId,
        message: content,
        source: 'system',
      });
    } catch (err) {
      console.error(`[SubagentService] Failed to route message to child session:`, err);
    }
  }

  private handleCompleted(_subagentId: string): void {
    // Manager already updated by complete_task tool
    // No additional cleanup needed for now
  }

  private handleCancelled(_subagentId: string): void {
    // Manager already updated by kill_subagent tool
    // Could signal child session to terminate here
  }

  /**
   * Handle adapter session close events to detect dead child processes.
   *
   * When an adapter session closes, find any tracked subagent whose
   * childSessionId matches and transition it to failed if still active.
   * @param sessionId - The session ID reported by the adapter as closed
   */
  private handleAdapterSessionClosed(sessionId: string): void {
    for (const subagent of this.manager.getAllNonTerminal()) {
      if (subagent.childSessionId === sessionId) {
        console.warn(`[SubagentService] Adapter session closed for subagent ${subagent.subagentId}: ${sessionId}`);
        this.manager.markFailed(subagent.subagentId, 'adapter-session-closed');
        return;
      }
    }
  }

  private async emitExecutionFailed(
    subagentId: string,
    parentSessionId: string,
    phase: SubagentExecutionFailed['phase'],
    err: unknown,
  ): Promise<void> {
    const error = err instanceof Error ? err.message : String(err);
    await this.bus
      .emit(SubagentSubjects.executionFailed, {
        subagentId,
        parentSessionId,
        phase,
        error,
      })
      .catch((emitErr) => {
        console.error('[SubagentService] Failed to emit executionFailed:', emitErr);
      });
  }
}
