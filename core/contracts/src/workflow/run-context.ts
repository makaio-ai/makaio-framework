import { z } from 'zod';
import { WorkflowDefinitionSchema, WorkflowExecutionScopeSchema } from './schemas.js';
import { JsonObjectContractSchema, JsonValueSchema } from '../shared/json-value.js';
import { WorkerContributionManifestSchema, WorkflowTriggerModeSchema } from './worker.js';
import { WorkflowArtifactRefSchema } from './artifact-ref.js';
import { SuspensionStrategySchema } from '../worker/suspension.js';
import { WorkerMaterializationSpecSchema } from '../capabilities/worker/types.js';
import { WorkflowError, WorkflowErrorCode } from './errors.js';

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
 * Builds the unrefined run-context object shape shared by the executable and
 * the stored schema. Only `definitionSnapshot` varies between the two: the
 * executable schema parses it as a {@link WorkflowDefinitionSchema}, the
 * stored schema keeps it as opaque JSON. Every other field is
 * identical, so this builder is the single place that defines them.
 * @param definitionSnapshotSchema - Schema for the (optional) definition snapshot field.
 * @returns An unrefined `z.object` with `definitionSnapshot` typed by `definitionSnapshotSchema`.
 */
function workflowRunContextObject<TDefinitionSnapshotSchema extends z.ZodTypeAny>(
  definitionSnapshotSchema: TDefinitionSnapshotSchema,
) {
  return z.object({
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
    definitionSnapshot: definitionSnapshotSchema.optional(),
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
  });
}

/**
 * Applies the three run-context invariants shared by the executable and the
 * stored schema: a definition-sourced context must carry a snapshot, and a
 * materialization spec is required for (and only for) a path source whose
 * `sourcePath` matches.
 *
 * `.extend()` cannot widen `definitionSnapshot` on an already-refined object,
 * and `.safeExtend()` requires type-compatible replacement fields, which the
 * stored schema deliberately violates (it widens the field to arbitrary
 * JSON). Applying the refinement once, after {@link workflowRunContextObject}
 * built the two differently-typed objects, keeps both schemas executable and
 * avoids re-declaring the invariants twice.
 * @param schema - Unrefined object built by {@link workflowRunContextObject}.
 * @returns The schema with the three invariants enforced via `.superRefine()`.
 */
function refineRunContextInvariants<TDefinitionSnapshotSchema extends z.ZodTypeAny>(
  schema: ReturnType<typeof workflowRunContextObject<TDefinitionSnapshotSchema>>,
) {
  return schema.superRefine((value, ctx) => {
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
}

/**
 * Persisted, per-execution snapshot of the configuration and context needed to
 * run a workflow.
 *
 * Created at execution start by the host, pulled by the executor over the
 * authenticated bus after connecting. Replaces the push-model delivery of
 * {@link WorkflowWorkerConfig} for Worker providers.
 *
 * Does NOT contain: bus URL, auth secret, credential values, or git tokens.
 * Those are transport/bootstrap or secret material, not durable run context.
 */
export const WorkflowRunContextSchema = refineRunContextInvariants(workflowRunContextObject(WorkflowDefinitionSchema));

export type WorkflowRunContext = z.infer<typeof WorkflowRunContextSchema>;

/**
 * Stored form of {@link WorkflowRunContextSchema}: identical shape, but
 * `definitionSnapshot` is opaque JSON instead of a parsed
 * {@link WorkflowDefinitionSchema}.
 *
 * This is what the storage layer reads back: `definition_snapshot` is
 * selected as stored text and decoded without interpreting the
 * node tree, so a snapshot that is no longer a valid definition — or not
 * even valid JSON — stays a readable value here instead of making the row
 * unreadable. Callers that need an executable definition call
 * {@link requireExecutableRunContext}.
 */
export const StoredWorkflowRunContextSchema = refineRunContextInvariants(workflowRunContextObject(JsonValueSchema));

export type StoredWorkflowRunContext = z.infer<typeof StoredWorkflowRunContextSchema>;

/**
 * Formats the issues of a failed run-context parse as `<path>: <message>`
 * entries joined by `; `, matching the reason convention used for stored
 * workflow definitions.
 * @param error - Zod error from a failed {@link WorkflowRunContextSchema} parse.
 * @returns The joined, human-readable reason.
 */
function describeRunContextIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
}

/**
 * Requires that a stored run context holds an executable definition snapshot.
 *
 * Parses the stored context with {@link WorkflowRunContextSchema}: a
 * snapshot that is not valid JSON, or that does not satisfy
 * {@link WorkflowDefinitionSchema}, fails visibly instead of being cast.
 * @param stored - Run context as read back from storage.
 * @returns The same run context, typed as executable.
 * @throws {@link WorkflowError} With code `DEFINITION_INVALID` when the stored
 * snapshot does not satisfy {@link WorkflowDefinitionSchema}.
 */
export function requireExecutableRunContext(stored: StoredWorkflowRunContext): WorkflowRunContext {
  const result = WorkflowRunContextSchema.safeParse(stored);
  if (!result.success) {
    throw new WorkflowError(
      WorkflowErrorCode.DEFINITION_INVALID,
      `Stored run context '${stored.executionId}' does not hold an executable definition: ${describeRunContextIssues(result.error)}`,
    );
  }
  return result.data;
}
