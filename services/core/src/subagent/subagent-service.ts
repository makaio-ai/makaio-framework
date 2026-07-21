// NOTE: do NOT change eslint rules without explicit human approval
/* eslint max-lines: ["error", { "max": 630, "skipBlankLines": true, "skipComments": true }] */
import { MakaioBus, type IMakaioBus } from '@makaio/bus-core';
import { BaseService } from '@makaio/service-base';
import type { BaseMessageContext, ExtractSubjectPayload } from '@makaio/core';
import { isPeerAuthorizedToDelegate, type SpawnDelegationAllowSet } from './spawn-delegation.js';
import {
  AgentSubjects,
  SubagentSubjects,
  SessionSubjects,
  AdapterSubjects,
  SubagentConfigSchema,
  DEFAULT_CONSTRAINTS,
  type SubagentConstraints,
  type SubagentConfig,
  type SubagentStatus,
  SpawnSubagentRpcRequestSchema,
  type ExecuteSubagentResponse,
  type SubagentExecutionFailed,
} from '@makaio/contracts';
import type { ExecutionTarget } from '@makaio/services-core/execution-target';
import { ExecutionTargetSubjects } from '../execution-target/namespace.js';
import { SessionStorageSubjects } from '../session/storage/namespace.js';
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
import { getSessionAgentAttachError } from '../session/handlers/attach-error.js';
import { attachSubagent } from './subagent-attach.js';

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

/**
 * Remove `undefined` values so optional adapter runtime fields remain absent on the bus payload.
 * @param obj - Object potentially containing undefined values.
 * @returns Object with undefined-valued keys omitted.
 */
/** Spawned event payload type inferred from schema */
type SpawnedPayload = ExtractSubjectPayload<typeof SubagentSubjects.spawned>;
type ExecuteSubagentPayload = ExtractSubjectPayload<typeof SubagentSubjects.execute>;
type ToChildPayload = ExtractSubjectPayload<typeof SubagentSubjects.toChild>;
type ChildSessionCreatePayload = ExtractSubjectPayload<typeof SessionSubjects.create>;
type AgentCompletePayload = ExtractSubjectPayload<typeof AgentSubjects.complete>;
type SessionTurnStartedPayload = ExtractSubjectPayload<typeof SessionSubjects.turn.started>;
type SessionTurnCompletedPayload = ExtractSubjectPayload<typeof SessionSubjects.turn.completed>;

/** Inputs for the atomic adapter-attach and initial-task startup phase. */
interface SpawnAttachParams {
  subagentId: string;
  parentSessionId: string;
  adapterName: string;
  config: SubagentConfig;
  sessionId: string;
  task: string;
  targetWorkingDirectory: string | undefined;
  shouldAbort: () => boolean;
}

/** Stable failures while finalizing a failed subagent spawn. */
export type SubagentFailureFinalizationErrorCode = 'child-session-close-failed' | 'failure-publication-failed';

/** Credential-free diagnostic for one failed spawn-finalization operation. */
export class SubagentFailureFinalizationError extends Error {
  /**
   * @param code - Stable finalization failure category.
   */
  public constructor(public readonly code: SubagentFailureFinalizationErrorCode) {
    super(`Subagent failure finalization failed (${code}).`);
    this.name = 'SubagentFailureFinalizationError';
  }
}

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
  private readonly pendingChildSessionClose = new Set<string>();
  private readonly spawningExecutions = new Set<string>();

  /**
   * Creates a new SubagentService instance.
   * @param bus - The event bus for inter-service communication
   * @param constraints - Subagent execution constraints
   * @param delegationAllowSet - Set of peer identities permitted to request
   *   spawn or execute on this node from a remote origin. Authenticated
   *   `workflow-execution` peers are allowed by identity; this set is for
   *   additional delegated peer kinds.
   * @param requestHandlerPriority - Priority for runtime-owned subagent lifecycle RPCs.
   * @param executionOwnerId - Stable identity used to bind spawned execution to this service instance.
   */
  public constructor(
    bus: IMakaioBus = MakaioBus,
    constraints: SubagentConstraints = DEFAULT_CONSTRAINTS,
    private readonly delegationAllowSet: SpawnDelegationAllowSet = new Set(),
    private readonly requestHandlerPriority = 0,
    private readonly executionOwnerId: string = crypto.randomUUID(),
  ) {
    super(bus);
    this.manager = new SubagentManager(constraints);
  }

  /**
   * Grant an authenticated peer permission to delegate spawn/execute requests.
   *
   * Adds the canonical `kind:id` key to the allow-set so subsequent remote
   * calls from this peer pass the delegation guard.
   * @param kind - Peer kind (e.g. `'workflow-execution'`)
   * @param id - Peer identifier
   */
  public grantDelegation(kind: string, id: string): void {
    this.delegationAllowSet.add(`${kind}:${id}`);
  }

  /**
   * Revoke delegation permission for an authenticated peer.
   *
   * Removes the canonical `kind:id` key from the allow-set. Subsequent
   * remote calls from this peer will be denied by the delegation guard.
   * @param kind - Peer kind (e.g. `'workflow-execution'`)
   * @param id - Peer identifier
   */
  public revokeDelegation(kind: string, id: string): void {
    this.delegationAllowSet.delete(`${kind}:${id}`);
  }

  /**
   * Register bus handlers for subagent lifecycle management.
   */
  protected onInit(): void {
    // Listen for spawned events to trigger execution
    this.registerHandler(SubagentSubjects.spawned, async (ctx) => {
      if (ctx.payload.executionOwnerId !== undefined && ctx.payload.executionOwnerId !== this.executionOwnerId) {
        return;
      }
      // Fire-and-forget: don't block the spawner
      this.handleSpawned(ctx.payload).catch((err) => {
        console.error('[SubagentService] handleSpawned error:', err);
      });
    });

    // Handle execute RPC (for explicit execution requests)
    this.registerHandler(SubagentSubjects.execute, async (ctx) => {
      if (!this.isRemoteDelegationAllowed(ctx)) {
        return;
      }
      const result = await this.handleExecute(ctx.payload);
      ctx.setResult(result);
    });

    // Route toChild messages to child sessions
    this.registerHandler(SubagentSubjects.toChild, async (ctx) => {
      await this.handleToChild(ctx.payload);
    });

    // Clean up on completion
    this.registerHandler(SubagentSubjects.completed, async (ctx) => {
      await this.handleCompleted(ctx.payload.subagentId);
    });

    // Clean up on cancellation
    this.registerHandler(SubagentSubjects.cancelled, async (ctx) => {
      await this.handleCancelled(ctx.payload.subagentId);
    });

    // Detect dead child adapter processes
    this.registerHandler(AdapterSubjects.session.closed, (ctx) => {
      this.handleAdapterSessionClosed(ctx.payload.sessionId);
    });

    // Terminalize turn-mode subagents when their first agent turn completes
    this.registerHandler(AgentSubjects.complete, async (ctx) => {
      await this.handleAgentComplete(ctx.payload);
    });

    this.registerHandler(SessionSubjects.turn.completed, async (ctx) => {
      await this.handleSessionTurnCompleted(ctx.payload);
    });

    this.registerHandler(SessionSubjects.turn.started, (ctx) => {
      this.handleSessionTurnStarted(ctx.payload);
    });

    this.registerHandler(AgentSubjects.tool.completed, (ctx) => {
      if (
        (ctx.payload as Record<string, unknown>)['_import'] ||
        ctx.payload.sessionId === undefined ||
        ctx.payload.success === undefined
      )
        return;
      this.manager.recordToolObservation(
        ctx.payload.sessionId,
        {
          toolName: ctx.payload.toolName,
          outcome: ctx.payload.success ? 'success' : 'failure',
          ...(ctx.payload.success === true && ctx.payload.artifactResult !== undefined
            ? { artifact: ctx.payload.artifactResult }
            : {}),
        },
        ctx.payload.toolCallId,
      );
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
      executionOwnerId: this.executionOwnerId,
      onCompletionCandidate: (subagentId) => this.finalizeSubagentIfReady(subagentId),
    };

    // getStatus RPC - query subagent state
    this.registerHandler(
      SubagentSubjects.getStatus,
      (busCtx) => {
        const result = handleGetStatusRpc(ctx, busCtx.payload);
        busCtx.setResult(result);
      },
      { priority: this.requestHandlerPriority },
    );

    // spawn RPC - validates constraints, tracks, emits spawned
    this.registerHandler(
      SubagentSubjects.spawn,
      async (busCtx) => {
        if (!this.isRemoteDelegationAllowed(busCtx)) {
          return;
        }
        const payload = SpawnSubagentRpcRequestSchema.parse(busCtx.payload);
        const result = await handleSpawnRpc(ctx, payload);
        busCtx.setResult(result);
      },
      { priority: this.requestHandlerPriority },
    );

    // await RPC - waits for terminal state or timeout
    this.registerHandler(
      SubagentSubjects.await,
      async (busCtx) => {
        const result = await handleAwaitRpc(ctx, busCtx.payload);
        busCtx.setResult(result);
      },
      { priority: this.requestHandlerPriority },
    );

    // send RPC - send message to subagent, optionally resolve pending
    this.registerHandler(SubagentSubjects.send, async (busCtx) => {
      const result = await handleSendRpc(ctx, busCtx.payload);
      busCtx.setResult(result);
    });

    // kill RPC - terminate subagent
    this.registerHandler(
      SubagentSubjects.kill,
      async (busCtx) => {
        const result = await handleKillRpc(ctx, busCtx.payload);
        busCtx.setResult(result);
      },
      { priority: this.requestHandlerPriority },
    );

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

  /** Clear deferred close state when the service lifecycle shuts down. */
  protected onDestroy(): void {
    this.pendingChildSessionClose.clear();
    this.spawningExecutions.clear();
  }

  /**
   * Handle spawned event - create session and start agent.
   * @param payload - Spawned event payload
   * @returns Error message on failure, undefined on success
   */
  private async handleSpawned(payload: SpawnedPayload): Promise<string | undefined> {
    const { subagentId, parentSessionId, task, spawningToolCallId } = payload;
    const existing = this.manager.get(subagentId);
    if (existing && existing.status !== 'spawning') {
      return undefined;
    }
    if (this.spawningExecutions.has(subagentId)) {
      return undefined;
    }
    this.spawningExecutions.add(subagentId);

    try {
      return await this.executeSpawned(payload, parentSessionId, task, spawningToolCallId);
    } finally {
      this.spawningExecutions.delete(subagentId);
    }
  }

  /**
   * Execute the single claimed spawn event for one subagent.
   * @param payload - Spawned event payload.
   * @param parentSessionId - Parent session that requested the subagent.
   * @param task - Task sent to the child agent.
   * @param spawningToolCallId - Tool call that initiated the spawn, if available.
   * @returns Error message on failure, otherwise undefined.
   */
  private async executeSpawned(
    payload: SpawnedPayload,
    parentSessionId: string,
    task: string,
    spawningToolCallId: string | undefined,
  ): Promise<string | undefined> {
    const { subagentId } = payload;
    const shouldAbort = () => this.shouldAbortSpawn(this.manager.get(subagentId)?.status);
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

    if (shouldAbort()) return undefined;
    return this.attachSpawnedSubagent({
      subagentId,
      parentSessionId,
      adapterName,
      config,
      sessionId,
      task,
      targetWorkingDirectory: resolutionParams.targetWorkingDirectory,
      shouldAbort,
    });
  }

  /**
   * Attach the child agent and atomically admit its initial task.
   * @param params - Resolved startup inputs and cancellation authority.
   * @returns Error message on failure, otherwise undefined.
   */
  private async attachSpawnedSubagent(params: SpawnAttachParams): Promise<string | undefined> {
    const { subagentId, parentSessionId, adapterName, config, sessionId, task, targetWorkingDirectory, shouldAbort } =
      params;
    try {
      await attachSubagent(this.bus, {
        subagentId,
        adapterName,
        config,
        sessionId,
        task,
        targetWorkingDirectory,
        assertAdmission: () => {
          if (this.shouldAbortSpawn(this.manager.get(subagentId)?.status)) throw new Error('startup cancelled');
        },
      });
    } catch (err) {
      if (shouldAbort()) return undefined;
      const attachError = getSessionAgentAttachError(err);
      return this.failSpawn(
        subagentId,
        parentSessionId,
        attachError?.stage === 'initial_message' ? 'agent_start' : 'adapter_start',
        err,
      );
    }

    if (!shouldAbort()) this.manager.markStarted(subagentId);
  }

  /**
   * Creates the child session and updates tracked subagent state.
   * @param subagentId - Subagent identifier
   * @param parentSessionId - Parent session identifier
   * @param config - Parsed subagent config
   * @param executionTargetId - Resolved execution target ID
   * @param resolutionParams - Parent-derived execution target and working-directory fields
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
      this.buildChildSessionCreatePayload(
        parentSessionId,
        config,
        executionTargetId,
        resolutionParams.targetWorkingDirectory,
        spawningToolCallId,
      ),
    );
    this.manager.setChildSessionId(subagentId, sessionId);
    if (this.pendingChildSessionClose.has(subagentId)) {
      await this.closeChildSession(subagentId);
    }
    return sessionId;
  }

  /**
   * Marks subagent spawn as failed and emits the lifecycle failure event.
   * @param subagentId - Subagent identifier
   * @param parentSessionId - Parent session identifier
   * @param phase - Spawn phase where failure occurred
   * @param reason - Error object or message
   * @returns Normalized error message
   * @throws AggregateError when child cleanup or failure publication also fails.
   */
  private async failSpawn(
    subagentId: string,
    parentSessionId: string,
    phase: SubagentExecutionFailed['phase'],
    reason: unknown,
  ): Promise<string> {
    const primaryFailure = reason instanceof Error ? reason : new Error(String(reason));
    this.manager.markFailed(subagentId, primaryFailure.message);

    const [closeResult, publicationResult] = await Promise.allSettled([
      this.manager.get(subagentId)?.childSessionId !== undefined
        ? this.requestChildSessionClose(subagentId)
        : Promise.resolve(),
      this.emitExecutionFailed(subagentId, parentSessionId, phase, primaryFailure),
    ]);
    const finalizationFailures: SubagentFailureFinalizationError[] = [];
    if (closeResult.status === 'rejected') {
      finalizationFailures.push(new SubagentFailureFinalizationError('child-session-close-failed'));
    }
    if (publicationResult.status === 'rejected') {
      finalizationFailures.push(new SubagentFailureFinalizationError('failure-publication-failed'));
    }
    if (finalizationFailures.length > 0) {
      throw new AggregateError(
        [primaryFailure, ...finalizationFailures],
        'Subagent spawn failed and failure finalization also failed.',
      );
    }
    return primaryFailure.message;
  }

  /**
   * Build execution-target resolution parameters for subagent spawn.
   *
   * Priority:
   * 1. Explicit subagent `executionTargetId`
   * 2. Parent session stamped target + working directory
   * @param parentSessionId - Parent session used as fallback context.
   * @param executionTargetId - Optional explicit target override from subagent config.
   * @returns Resolution parameters for `ExecutionTargetSubjects.resolve`.
   */
  private async buildExecutionTargetResolutionParams(
    parentSessionId: string,
    executionTargetId?: string,
  ): Promise<{
    executionTargetId?: string;
    targetWorkingDirectory?: string;
  }> {
    if (executionTargetId !== undefined) return { executionTargetId };
    const { session: parentSession } = await this.bus.request(SessionStorageSubjects.get, {
      sessionId: parentSessionId,
    });
    if (!parentSession) {
      throw new Error(`Parent session not found: ${parentSessionId}`);
    }

    return {
      ...(parentSession.executionTargetId !== undefined && { executionTargetId: parentSession.executionTargetId }),
      ...(parentSession.targetWorkingDirectory !== undefined && {
        targetWorkingDirectory: parentSession.targetWorkingDirectory,
      }),
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
   * @param targetWorkingDirectory - Parent working directory inherited by the child session
   * @param spawningToolCallId - Tool call ID that triggered the spawn, if available
   * @returns Session.create payload for the child session
   */
  private buildChildSessionCreatePayload(
    parentSessionId: string,
    config: SubagentConfig,
    executionTargetId: string | undefined,
    targetWorkingDirectory: string | undefined,
    spawningToolCallId: string | undefined,
  ): ChildSessionCreatePayload {
    return {
      branchKind: 'subagent' as const,
      parentSessionId,
      contextInheritance: config.contextMode === 'fork' ? 'parent-history' : 'none',
      ...(executionTargetId !== undefined && { executionTargetId }),
      ...(targetWorkingDirectory !== undefined && { targetWorkingDirectory }),
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

  /**
   * Handle terminal successful subagent completion.
   * @param subagentId - Completed subagent identifier.
   */
  private async handleCompleted(subagentId: string): Promise<void> {
    await this.closeChildSession(subagentId);
  }

  /**
   * Handle terminal subagent cancellation.
   * @param subagentId - Cancelled subagent identifier.
   */
  private async handleCancelled(subagentId: string): Promise<void> {
    await this.closeChildSession(subagentId);
  }

  /**
   * Close a subagent child session once the subagent reaches a terminal state.
   *
   * The close operation is best-effort because subagent state has already
   * transitioned terminal; a session-close failure should not undo completion
   * or cancellation.
   * @param subagentId - Subagent whose child session should be closed.
   */
  private async closeChildSession(subagentId: string): Promise<void> {
    try {
      await this.requestChildSessionClose(subagentId);
    } catch {
      console.error(
        `[SubagentService] Failed to close child session for subagent ${subagentId}:`,
        new SubagentFailureFinalizationError('child-session-close-failed'),
      );
    }
  }

  /**
   * Close a tracked child session while preserving failures for transactional callers.
   * @param subagentId - Subagent whose child session should be closed.
   * @throws Error when the session close request fails.
   */
  private async requestChildSessionClose(subagentId: string): Promise<void> {
    const tracked = this.manager.get(subagentId);
    if (!tracked) return;
    if (!tracked.childSessionId) {
      this.pendingChildSessionClose.add(subagentId);
      return;
    }
    this.pendingChildSessionClose.delete(subagentId);
    await this.bus.request(SessionSubjects.close, { sessionId: tracked.childSessionId });
  }

  /**
   * Check whether startup must stop for missing or terminal subagent state.
   * @param status - Current tracked subagent status, when still retained.
   * @returns True when the subagent must no longer receive startup work.
   */
  private shouldAbortSpawn(status: SubagentStatus | undefined): boolean {
    return status === undefined || status === 'completed' || status === 'failed' || status === 'cancelled';
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

  /**
   * Record turn-mode completion intent; canonical session completion owns terminalization.
   * @param payload - Correlated agent completion event.
   */
  private async handleAgentComplete(payload: AgentCompletePayload): Promise<void> {
    const { sessionId, turnId, outcome, message, error } = payload;

    if (!sessionId || !turnId) return;

    for (const subagent of this.manager.getAllNonTerminal()) {
      if (subagent.childSessionId !== sessionId) continue;

      if ((subagent.config.completion ?? 'tool') !== 'turn') return;
      if (subagent.status === 'waiting_input') return;
      const effectiveOutcome = outcome ?? 'completed';
      if (effectiveOutcome === 'completed') {
        try {
          this.manager.recordCompletionCandidate(subagent.subagentId, turnId, message ?? '', undefined, 'turn');
          await this.finalizeSubagentIfReady(subagent.subagentId);
        } catch {
          return;
        }
      } else if (effectiveOutcome === 'error') {
        try {
          this.manager.recordCompletionCandidate(
            subagent.subagentId,
            turnId,
            error ?? 'child turn failed',
            undefined,
            'turn',
          );
          await this.finalizeSubagentIfReady(subagent.subagentId);
        } catch {
          return;
        }
      }
      return;
    }
  }

  /**
   * Reconcile canonical child turn completion with a matching completion intent.
   * @param payload - Persisted session turn completion.
   */
  private async handleSessionTurnCompleted(payload: SessionTurnCompletedPayload): Promise<void> {
    if (payload.ingestionMarker === 'backfill') return;
    for (const subagent of this.manager.getAllNonTerminal()) {
      if (subagent.childSessionId !== payload.sessionId) continue;
      this.manager.recordTurnCompleted(payload.sessionId, payload.turnId);
      this.manager.recordCompletedTurn(
        subagent.subagentId,
        payload.turnId,
        payload.usage,
        payload.success,
        payload.error,
      );
      const candidate = subagent.completionCandidate;
      if (candidate?.turnId !== payload.turnId) return;
      await this.finalizeSubagentIfReady(subagent.subagentId);
      return;
    }
  }

  /**
   * Project live child turns so completion RPCs bind to canonical session state.
   * @param payload - Child session turn-start lifecycle event.
   */
  private handleSessionTurnStarted(payload: SessionTurnStartedPayload): void {
    if (payload.ingestionMarker === 'backfill') return;
    this.manager.recordTurnStarted(payload.sessionId, payload.turnId);
  }

  /**
   * Publish only the terminal snapshot frozen after both completion proofs exist.
   * @param subagentId - Subagent whose proofs may now reconcile.
   */
  private async finalizeSubagentIfReady(subagentId: string): Promise<void> {
    if (!this.manager.finalizeCompletionIfReady(subagentId)) return;
    const completed = this.manager.get(subagentId);
    await this.bus.emit(SubagentSubjects.completed, {
      subagentId,
      success: completed?.status === 'completed',
      ...(completed?.status === 'completed'
        ? {
            result: completed.summary ? `${completed.summary}\n\n${completed.result ?? ''}` : completed?.result,
            usage: completed.usage,
          }
        : { error: completed?.error ?? 'child turn failed' }),
    });
  }

  /**
   * Return true when a handler may proceed.
   *
   * Local callers always proceed. Remote callers proceed only when they are an
   * authenticated workflow execution peer or their authenticated peer appears
   * in the delegation allow-set.
   * @param ctx - Incoming message context
   * @returns True when the handler should process the request
   */
  private isRemoteDelegationAllowed(ctx: BaseMessageContext): boolean {
    return ctx.origin.local || isPeerAuthorizedToDelegate(ctx.transport?.peer, this.delegationAllowSet);
  }

  private async emitExecutionFailed(
    subagentId: string,
    parentSessionId: string,
    phase: SubagentExecutionFailed['phase'],
    err: unknown,
  ): Promise<void> {
    const error = err instanceof Error ? err.message : String(err);
    await this.bus.emit(SubagentSubjects.executionFailed, {
      subagentId,
      parentSessionId,
      phase,
      error,
    });
  }
}
