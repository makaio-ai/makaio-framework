import type { z } from 'zod';
import type { IMakaioBus } from '@makaio/bus-core';
import type { BaseMessageContext } from '@makaio/core';
import {
  JsonPatchOperationSchema,
  EXTERNAL_EXECUTION_ID_PREFIX,
  type IWorkflowTriggerTypeRegistry,
  type JsonValue,
  type WorkLogFrameEntry,
  type WorkflowDefinition,
  type WorkflowExecution,
} from '@makaio/contracts';
import { WorkflowSchemas, WorkflowSubjects } from './namespace.js';
import { WorkflowStorageSubjects } from './storage/namespace.js';
import { assertWorkflowStateValueMatchesSchema } from './workflow-state-validation.js';
import { generateId } from './executor-helpers.js';

type RegisterExternalExecutionRequest = z.infer<typeof WorkflowSchemas.registerExternalExecution.request>;
type CompleteExternalExecutionRequest = z.infer<typeof WorkflowSchemas.completeExternalExecution.request>;

/**
 * Return `true` when `executionId` was produced by `registerExternalExecution`.
 *
 * The prefix check is the primary discriminant. It covers all engine-internal
 * paths including `persistPreRuntimeTerminalExecution`, which writes an
 * engine-owned row via `setExecution` (not `setExecutionStart`) when the
 * worker signal is already aborted before the runtime starts — a path that
 * would pass a run-context-only guard because run-context rows may be absent
 * in that abort window.
 * @param executionId - Execution identifier to classify.
 * @returns `true` when the execution was externally registered.
 */
function isExternalExecutionId(executionId: string): boolean {
  return executionId.startsWith(EXTERNAL_EXECUTION_ID_PREFIX);
}

/**
 * Build optional execution fields for externally registered rows.
 * @param payload - Parsed external registration request.
 * @returns Execution fields that should be persisted only when provided.
 */
function buildExternalExecutionOptionals(
  payload: Pick<RegisterExternalExecutionRequest, 'artifactRef' | 'triggerPayload'>,
): Partial<Pick<WorkflowExecution, 'artifactRef' | 'triggerPayload'>> {
  const optionals: Partial<Pick<WorkflowExecution, 'artifactRef' | 'triggerPayload'>> = {};
  if (payload.artifactRef !== undefined) {
    optionals.artifactRef = payload.artifactRef;
  }
  if (payload.triggerPayload !== undefined) {
    optionals.triggerPayload = payload.triggerPayload;
  }
  return optionals;
}

/**
 * Build terminal metadata that matches the requested external completion status.
 * @param payload - Parsed external completion request.
 * @returns Error or cancellation metadata for the storage update.
 */
function buildExternalCompletionMetadata(
  payload: Pick<CompleteExternalExecutionRequest, 'status' | 'error' | 'reason'>,
): Partial<Pick<WorkflowExecution, 'error' | 'reason'>> {
  if (payload.status === 'failed') {
    if (payload.error === undefined) {
      throw new Error("status 'failed' requires a non-empty 'error' message");
    }
    return { error: payload.error };
  }
  if (payload.status === 'cancelled') {
    if (payload.reason === undefined) {
      throw new Error("status 'cancelled' requires a non-empty 'reason' string");
    }
    return { reason: payload.reason };
  }
  return {};
}

/**
 * Enforce the trust-boundary rules for execution-bound public RPC subjects.
 *
 * - Local callers are always permitted (hot path, no transport round-trip).
 * - Direct-HMAC callers must present an authenticated `workflow-execution`
 *   peer whose `id === executionId`.
 * - Relay callers must present an encrypted E2E peer whose relay identity is
 *   also bound to `executionId`. Encryption alone is not authorization.
 * - All other remote callers are denied.
 * @param ctx - Incoming message context.
 * @param executionId - The requested execution identifier.
 * @returns `true` when the caller may access the execution-bound resource.
 */
function isExecutionBoundAccessAllowed(ctx: BaseMessageContext, executionId: string): boolean {
  if (ctx.origin.local) {
    return true;
  }
  const peer = ctx.transport?.peer;
  if (peer?.authenticated !== true) {
    return false;
  }
  if (peer.id !== executionId) {
    return false;
  }
  if (peer.kind === 'workflow-execution') {
    return true;
  }
  return peer.kind === 'e2e' && peer.encrypted === true;
}

/**
 * Load the workflow definition snapshot used to authorize state schema changes.
 * @param bus - Message bus used for storage requests.
 * @param executionId - Execution whose workflow state is being mutated.
 * @returns Workflow definition snapshot, or `undefined` when no state contract is available.
 */
async function loadStateWorkflowSnapshot(
  bus: IMakaioBus,
  executionId: string,
): Promise<WorkflowDefinition | undefined> {
  const { runContext } = await bus.request(WorkflowStorageSubjects.getRunContext, { executionId });
  if (runContext === null) {
    throw new Error(`Run context not found for execution: ${executionId}`);
  }
  if (runContext.definitionSnapshot !== undefined) {
    return runContext.definitionSnapshot;
  }
  const { workflow } = await bus.request(WorkflowStorageSubjects.get, { id: runContext.workflowId });
  return workflow ?? undefined;
}

/**
 * Register handlers that delegate workflow contract subjects to storage subjects.
 * @param bus - Message bus
 * @returns Cleanup functions for all registered handlers
 */
export function registerWorkflowStorageDelegationHandlers(bus: IMakaioBus): Array<() => void> {
  return [
    bus.on(WorkflowSubjects.getDefinition, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.get, { id: ctx.payload.id });
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.setDefinition, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.set, { workflow: ctx.payload.workflow });
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.deleteDefinition, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.delete, { id: ctx.payload.id });
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.listDefinitions, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.list, ctx.payload);
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.getExecution, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.getExecution, {
        executionId: ctx.payload.executionId,
      });
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.listExecutions, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.listExecutions, ctx.payload);
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.listExecutionsByArtifactRefs, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.listExecutionsByArtifactRefs, ctx.payload);
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.listSpans, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.listSpans, {
        executionId: ctx.payload.executionId,
      });
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.listFrames, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.listFrames, {
        executionId: ctx.payload.executionId,
      });
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.listGateInstances, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.listGateInstances, ctx.payload);
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.setExecutionLink, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.setExecutionLink, { link: ctx.payload.link });
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.listExecutionLinks, async (ctx) => {
      const result = await bus.request(WorkflowStorageSubjects.listExecutionLinks, ctx.payload);
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.getRunContext, async (ctx) => {
      const { executionId } = ctx.payload;
      if (!isExecutionBoundAccessAllowed(ctx, executionId)) {
        throw new Error(`Unauthorized: caller is not permitted to read run context for execution: ${executionId}`);
      }
      const { runContext } = await bus.request(WorkflowStorageSubjects.getRunContext, { executionId });
      if (!runContext) {
        throw new Error(`Run context not found for execution: ${executionId}`);
      }
      ctx.setResult(runContext);
    }),
    ...registerExternalExecutionHandlers(bus),
  ];
}

/**
 * Register handlers for external (engine-bypass) execution lifecycle.
 *
 * External executions and their WorkLog summary/frame are written through
 * atomic storage subjects. Standard lifecycle events remain advisory; no
 * coordinator session, run-context snapshot, or runtime state is created.
 * @param bus - Message bus
 * @returns Cleanup functions for the registered handlers
 */
function registerExternalExecutionHandlers(bus: IMakaioBus): Array<() => void> {
  return [
    bus.on(WorkflowSubjects.registerExternalExecution, async (ctx) => {
      const payload = WorkflowSchemas.registerExternalExecution.request.parse(ctx.payload);
      const { name, scope, input } = payload;
      if (payload.executionId !== undefined && !ctx.origin.local) {
        throw new Error('registerExternalExecution: caller-supplied executionId is restricted to local callers');
      }
      // `generateId('wfx-ext')` produces `wfx-ext-<timestamp>-<random>`, which
      // satisfies EXTERNAL_EXECUTION_ID_PREFIX and is disjoint from engine IDs.
      const executionId = payload.executionId ?? generateId('wfx-ext');
      if (!isExternalExecutionId(executionId)) {
        throw new Error('registerExternalExecution: executionId must use the wfx-ext- prefix');
      }
      const startedAt = payload.startedAt ?? Date.now();
      const execution: WorkflowExecution & { status: 'running' } = {
        id: executionId,
        workflowId: name,
        status: 'running',
        // Preserve explicit null: `undefined` means no input provided (default to {}),
        // but `null` is a valid JSON value that must round-trip unchanged.
        inputs: input === undefined ? {} : input,
        startedAt,
        scope: scope ?? { type: 'global' },
        ...buildExternalExecutionOptionals(payload),
      };
      const frame = resolveExternalStartFrame(executionId, startedAt, payload.frame);
      const result = await bus.request(WorkflowStorageSubjects.setExternalExecutionStart, {
        execution,
        ...(frame !== undefined ? { frame } : {}),
      });
      ctx.setResult(result);
    }),
    bus.on(WorkflowSubjects.completeExternalExecution, async (ctx) => {
      // Bus schema validation is disabled in production; parse here because the
      // terminal metadata rules are storage invariants, not just dev-time checks.
      const payload = WorkflowSchemas.completeExternalExecution.request.parse(ctx.payload);
      const { executionId, status } = payload;
      // Primary guard: only executions registered through registerExternalExecution
      // carry the EXTERNAL_EXECUTION_ID_PREFIX. Engine IDs use the plain `wfx-` prefix.
      // This covers all engine paths including persistPreRuntimeTerminalExecution,
      // which writes an engine-owned terminal row via setExecution (without creating
      // a run-context) when the worker signal aborts before the runtime starts.
      if (!isExternalExecutionId(executionId)) {
        throw new Error(
          `completeExternalExecution: execution "${executionId}" is engine-owned and must be completed through the engine finalizer, not this API`,
        );
      }
      const frame = resolveExternalTerminalFrame(payload);
      const result = await bus.request(WorkflowStorageSubjects.settleExternalExecution, {
        executionId,
        status,
        ...buildExternalCompletionMetadata(payload),
        ...(payload.completedAt !== undefined ? { completedAt: payload.completedAt } : {}),
        ...(frame !== undefined ? { frame } : {}),
      });
      ctx.setResult({ success: result.success });
    }),
  ];
}

/**
 * Resolve optional external frame metadata after the execution ID is known.
 * @param executionId - Resolved external execution identifier.
 * @param executionStartedAt - Durable execution start timestamp.
 * @param frame - Optional caller-supplied frame start metadata.
 * @returns Resolved running WorkLog frame, or `undefined` when omitted.
 */
function resolveExternalStartFrame(
  executionId: string,
  executionStartedAt: number,
  frame: RegisterExternalExecutionRequest['frame'],
): (WorkLogFrameEntry & { status: 'running'; startedAt: number }) | undefined {
  if (frame === undefined) return undefined;
  const frameId = frame.frameId ?? `${executionId}:${frame.nodeId}`;
  return {
    executionId,
    frameId,
    nodeId: frame.nodeId,
    nodeType: frame.nodeType,
    path: frame.path ?? [frameId],
    status: 'running',
    attempt: frame.attempt,
    ...(frame.iteration !== undefined ? { iteration: frame.iteration } : {}),
    ...(frame.branchKey !== undefined ? { branchKey: frame.branchKey } : {}),
    startedAt: frame.startedAt ?? executionStartedAt,
  };
}

/**
 * Resolve exact terminal frame values from an external completion request.
 * @param payload - Parsed external completion request.
 * @returns Resolved terminal WorkLog frame, or `undefined` when omitted.
 */
function resolveExternalTerminalFrame(payload: CompleteExternalExecutionRequest):
  | (WorkLogFrameEntry & {
      status: 'completed' | 'failed' | 'cancelled';
      startedAt: number;
      completedAt: number;
      durationMs: number;
    })
  | undefined {
  if (payload.frame === undefined) return undefined;
  if (payload.completedAt === undefined) {
    throw new Error('completedAt is required when frame metadata is supplied');
  }
  const durationMs = payload.completedAt - payload.frame.startedAt;
  if (durationMs < 0) throw new Error('completedAt must not precede frame.startedAt');
  if (payload.frame.durationMs !== undefined && payload.frame.durationMs !== durationMs) {
    throw new Error('frame.durationMs must equal completedAt - frame.startedAt');
  }
  return {
    executionId: payload.executionId,
    frameId: payload.frame.frameId,
    nodeId: payload.frame.nodeId,
    nodeType: payload.frame.nodeType,
    path: payload.frame.path,
    status: payload.status,
    attempt: payload.frame.attempt,
    ...(payload.frame.iteration !== undefined ? { iteration: payload.frame.iteration } : {}),
    ...(payload.frame.branchKey !== undefined ? { branchKey: payload.frame.branchKey } : {}),
    startedAt: payload.frame.startedAt,
    completedAt: payload.completedAt,
    durationMs,
    ...(payload.status === 'failed' && payload.error !== undefined ? { error: payload.error } : {}),
  };
}

/**
 * Register public-facing workflow state bus handlers.
 *
 * These handlers delegate to internal storage subjects and emit
 * lifecycle events. They are registered by the executor during init.
 * @param bus - The bus to register handlers on
 * @returns Array of cleanup functions for handler deregistration
 */
export function registerWorkflowStateHandlers(bus: IMakaioBus): Array<() => void> {
  return [
    bus.on(WorkflowSubjects.state.get, async (ctx) => {
      const { executionId } = ctx.payload;
      if (!isExecutionBoundAccessAllowed(ctx, executionId)) {
        throw new Error(`Unauthorized: caller is not permitted to read state for execution: ${executionId}`);
      }
      const { state } = await bus.request(WorkflowStorageSubjects.getState, { executionId });
      if (state === null) {
        throw new Error(`no workflow state for execution ${executionId}`);
      }
      ctx.setResult(state);
    }),

    bus.on(WorkflowSubjects.state.patch, async (ctx) => {
      const { executionId, expectedSequence, patch, nextValue } = ctx.payload;
      if (!isExecutionBoundAccessAllowed(ctx, executionId)) {
        throw new Error(`Unauthorized: caller is not permitted to patch state for execution: ${executionId}`);
      }
      if (expectedSequence === undefined) {
        throw new Error('expectedSequence is required to patch workflow state');
      }
      const workflow = await loadStateWorkflowSnapshot(bus, executionId);
      if (workflow !== undefined) {
        assertWorkflowStateValueMatchesSchema(workflow, nextValue as JsonValue, 'next');
      }
      JsonPatchOperationSchema.array().parse(patch);
      const result = await bus.request(WorkflowStorageSubjects.patchState, {
        executionId,
        expectedSequence,
        nextValue: nextValue as JsonValue,
      });
      bus
        .emit(WorkflowSubjects.state.updated, {
          executionId: result.executionId,
          sequence: result.sequence,
          patch: result.patch,
          value: result.value,
          updatedAt: Date.now(),
        })
        .catch(() => {
          // observer failures must not reject the RPC after state is persisted
        });
      ctx.setResult({ executionId: result.executionId, sequence: result.sequence, value: result.value });
    }),
  ];
}

/**
 * Register trigger type query handlers.
 * @param bus - Message bus
 * @param getRegistry - Lazy trigger registry accessor
 * @returns Cleanup functions for registered handlers
 */
export function registerWorkflowTriggerTypeHandlers(
  bus: IMakaioBus,
  getRegistry: () => IWorkflowTriggerTypeRegistry | undefined,
): Array<() => void> {
  return [
    bus.on(WorkflowSubjects.listTriggerTypes, (ctx) => {
      const triggerTypes = getRegistry()?.getAll() ?? [];
      ctx.setResult({ triggerTypes });
    }),
  ];
}
