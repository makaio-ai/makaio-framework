import { z } from 'zod';
import { WorkflowDefinitionSchema, WorkflowExecutionScopeSchema } from './schemas.js';
import { JsonObjectContractSchema, JsonValueSchema } from '../shared/json-value.js';
import { WorkerContributionManifestSchema, WorkflowTriggerModeSchema } from './worker.js';
import { WorkflowArtifactRefSchema } from './artifact-ref.js';
import { SuspensionStrategySchema } from '../worker-node/suspension.js';
import { WorkerMaterializationSpecSchema } from '../capabilities/worker-node/types.js';

/**
 * Durable source descriptor for a workflow execution.
 *
 * Bootstrap worker configuration may contain a worker-local path. Durable
 * path sources are instead workspace-relative and acquire their local
 * realization only through a materialization spec.
 */
const WorkflowRunContextSourceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('path'),
      path: z
        .string()
        .min(1)
        .refine((path) => !path.startsWith('/') && !/^[A-Za-z]:[/\\]/.test(path), {
          message: 'path must be workspace-relative (no leading / or drive letter)',
        }),
    })
    .strict(),
  z.object({ kind: z.literal('source'), filename: z.string().min(1), source: z.string() }).strict(),
  z.object({ kind: z.literal('definition'), workflowId: z.string().min(1) }).strict(),
]);

/** Durable source descriptor for a workflow execution. */
export type WorkflowRunContextSource = z.infer<typeof WorkflowRunContextSourceSchema>;

/**
 * Persisted, per-execution snapshot of the configuration and context needed to
 * run a workflow.
 *
 * Created at execution start by the host, pulled by the executor over the
 * authenticated bus after connecting. Replaces the push-model delivery of
 * {@link WorkflowWorkerConfig} for WorkerNode providers.
 *
 * Does NOT contain: bus URL, auth secret, credential values, or git tokens.
 * Those are transport/bootstrap or secret material, not durable run context.
 */
export const WorkflowRunContextSchema = z
  .object({
    /** The executionId this context belongs to (1:1 with WorkflowExecution). */
    executionId: z.string().min(1),
    /** Workflow definition being executed. */
    workflowId: z.string().min(1),
    /** Where to load the workflow from. */
    source: WorkflowRunContextSourceSchema,
    /**
     * Concrete definition snapshot for `source.kind === 'definition'`.
     *
     * Required for definition-sourced executions so a later definition edit
     * cannot change the behaviour of an already-created execution.
     */
    definitionSnapshot: WorkflowDefinitionSchema.optional(),
    /** Resolved worker-local contribution packages for this execution. */
    workerManifest: WorkerContributionManifestSchema.default({ contributionRefs: [] }),
    /** Bound input value. */
    inputs: JsonValueSchema.default({}),
    /** Bound workflow configuration values. */
    config: JsonObjectContractSchema.optional(),
    /** Resolved execution scope. */
    scope: WorkflowExecutionScopeSchema.default({ type: 'global' }),
    /** Trigger payload from cron/event/manual start. */
    triggerPayload: JsonObjectContractSchema.default({}),
    /** Explicitly selects immediate execution or trigger-awaiting execution. */
    triggerMode: WorkflowTriggerModeSchema.optional(),
    /**
     * Explicit artifact reference supplied by the execution starter.
     *
     * When present, workflow artifact binding resolves this artifact before
     * evaluating definition-level resolve/create expressions.
     */
    artifactRef: WorkflowArtifactRefSchema.optional(),
    /** Coordinator session that owns this execution. */
    coordinatorSessionId: z.string().min(1),
    /**
     * Opaque dispatch metadata that must survive pause/resume boundaries.
     *
     * Framework code treats this as a generic JSON object. Product-owned
     * dispatchers may store non-secret routing identity here so resumed
     * executions can be handed back to the same dispatch target.
     */
    dispatchMetadata: JsonObjectContractSchema.optional(),
    /** Bus subject for cancellation signals. */
    cancelSubject: z.string().min(1),
    /** Extra non-secret environment variables. */
    env: z.record(z.string(), z.string()).default({}),
    /** Snapshot creation timestamp (epoch ms). */
    createdAt: z.number(),
    /**
     * Durable record of the suspension strategy selected for this execution.
     *
     * Persisted alongside the run context so resumers and redispatchers can
     * apply the same strategy without re-resolving provider capabilities.
     * Defaults to `'wait-in-process'` for executions started before this
     * field was introduced.
     */
    suspensionStrategy: SuspensionStrategySchema.default('wait-in-process'),
    /** Component that exclusively owns durable terminalization for this execution. */
    terminalAuthority: z.enum(['worker', 'authority']).optional(),
    /**
     * Portable materialization specification for path-backed workflows.
     *
     * Required when `source.kind === 'path'` — tells the worker how to
     * obtain its workspace contents without an Authority-local absolute
     * path. Optional (absent) for `source.kind === 'definition'` and
     * `source.kind === 'source'` because those self-contained workflows
     * need no filesystem materialization.
     *
     * The host seam supplies a resolved spec at execution start. The spec
     * is persisted alongside the run context so resumers and redispatchers
     * can materialize the workspace without re-resolving.
     */
    materializationSpec: WorkerMaterializationSpecSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.source.kind === 'definition' && value.definitionSnapshot === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['definitionSnapshot'],
        message: 'definitionSnapshot is required when source.kind is "definition"',
      });
    }
    if (value.source.kind === 'path') {
      if (value.materializationSpec === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['materializationSpec'],
          message: 'materializationSpec is required when source.kind is "path"',
        });
      } else if (value.materializationSpec.sourcePath !== value.source.path) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['materializationSpec', 'sourcePath'],
          message: 'materializationSpec.sourcePath must match source.path',
        });
      }
    } else if (value.materializationSpec !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['materializationSpec'],
        message: 'materializationSpec is only valid when source.kind is "path"',
      });
    }
  });

export type WorkflowRunContext = z.infer<typeof WorkflowRunContextSchema>;
