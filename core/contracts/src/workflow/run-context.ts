import { z } from 'zod';
import { WorkflowDefinitionSchema, WorkflowExecutionScopeSchema } from './schemas.js';
import { JsonObjectContractSchema, JsonValueSchema } from '../shared/json-value.js';
import { WorkflowWorkerSourceSchema, WorkerContributionManifestSchema } from './worker.js';
import { WorkflowArtifactRefSchema } from './artifact-ref.js';
import { ExecutionHintsSchema } from './execution-hints.js';

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
    source: WorkflowWorkerSourceSchema,
    /**
     * Concrete definition snapshot for `source.kind === 'definition'`.
     *
     * Required for definition-sourced executions so a later definition edit
     * cannot change the behaviour of an already-created execution.
     */
    definitionSnapshot: WorkflowDefinitionSchema.optional(),
    /** Resolved worker-local contribution packages for this execution. */
    workerManifest: WorkerContributionManifestSchema.default({ packages: [] }),
    /** Bound input value. */
    inputs: JsonValueSchema.default({}),
    /** Bound workflow configuration values. */
    config: JsonObjectContractSchema.optional(),
    /** Resolved execution scope. */
    scope: WorkflowExecutionScopeSchema.default({ type: 'global' }),
    /** Trigger payload from cron/event/manual start. */
    triggerPayload: JsonObjectContractSchema.default({}),
    /**
     * Explicit artifact reference supplied by the execution starter.
     *
     * When present, workflow artifact binding resolves this artifact before
     * evaluating definition-level resolve/create expressions.
     */
    artifactRef: WorkflowArtifactRefSchema.optional(),
    /** Coordinator session that owns this execution. */
    coordinatorSessionId: z.string().min(1),
    /** Advisory worker provisioning hints supplied by the start request. */
    executionHints: ExecutionHintsSchema.optional(),
    /** Bus subject for cancellation signals. */
    cancelSubject: z.string().min(1),
    /** Platform/workspace context for expression resolution and tool access. */
    context: z.object({
      /** Absolute path to the active repository root. */
      repoPath: z.string().min(1),
      /** Absolute path to the Makaio home directory. */
      makaioHome: z.string().min(1),
      /** Host operating system. */
      os: z.enum(['darwin', 'linux', 'win32']),
      /** CPU architecture (e.g. `'arm64'`, `'x64'`). */
      arch: z.string().min(1),
      /** Active git worktree path, if different from `repoPath`. */
      worktree: z.string().optional(),
    }),
    /** Extra non-secret environment variables. */
    env: z.record(z.string(), z.string()).default({}),
    /** Snapshot creation timestamp (epoch ms). */
    createdAt: z.number(),
  })
  .superRefine((value, ctx) => {
    if (value.source.kind === 'definition' && value.definitionSnapshot === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['definitionSnapshot'],
        message: 'definitionSnapshot is required when source.kind is "definition"',
      });
    }
  });

export type WorkflowRunContext = z.infer<typeof WorkflowRunContextSchema>;
