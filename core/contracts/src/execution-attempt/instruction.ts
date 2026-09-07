import { z } from 'zod';
import { JsonValueSchema } from '../shared/json-value.js';

const identifier = z.string().min(1);

const relativePath = identifier.refine(
  (path) =>
    !path.startsWith('/') && !path.includes('\\') && !/^[A-Za-z]:/.test(path) && !path.split('/').includes('..'),
  { message: 'Source paths must be workspace-relative and may not traverse outside the workspace' },
);

/** One already-authorized setup command; credentials are injected locally, never stored here. */
export const WorkspaceSetupCommandSchema = z
  .object({
    command: identifier,
    args: z.array(z.string()),
    /** Non-secret environment values only. */
    env: z.record(z.string(), z.string()),
    timeoutMs: z.number().int().positive(),
  })
  .strict();

/** Portable working-area requirement; the host supplies the concrete local root separately. */
export const WorkspaceRequirementSchema = z
  .object({
    provisioning: z.enum(['bind', 'create']),
    /** Custody is independent of whether the directory already exists. */
    custody: z.enum(['external', 'disposable']),
    /** Collection seam; local executors initially support at most one source root. */
    sourceRoots: z.array(
      z
        .object({
          id: identifier,
          path: relativePath,
          /** Source-specific non-secret input; absence binds files already present. */
          source: z.object({ kind: identifier, input: JsonValueSchema }).strict().optional(),
        })
        .strict(),
    ),
    setup: z.array(WorkspaceSetupCommandSchema),
  })
  .strict();

/** What must survive before destructive release; an empty list explicitly declares scratch work. */
export const ExecutionPreservationRequirementsSchema = z
  .object({
    required: z.array(z.enum(['source-state', 'diagnostics', 'workspace-state', 'live-state'])),
  })
  .strict();

/** Frozen non-secret assignment bound by the execution owner to one Attempt. */
export const ExecutionAttemptInstructionSchema = z
  .object({
    id: identifier,
    revision: identifier,
    /** Required installed adapter and its opaque, immutable input. */
    workload: z.object({ kind: identifier, version: identifier, input: JsonValueSchema }).strict(),
    workspace: WorkspaceRequirementSchema.optional(),
    preservation: ExecutionPreservationRequirementsSchema,
  })
  .strict();

/** Local filesystem realization, valid only for the reporting Attempt/runtime generation. */
export const ExecutionAttemptWorkspaceBindingSchema = z
  .object({
    workspaceRoot: identifier,
    sourceRoots: z.array(z.object({ id: identifier, path: identifier }).strict()),
  })
  .strict();

/** Successful, non-terminal Preparation result; its acceptance permits Invocation. */
export const ExecutionAttemptPreparationResultSchema = z
  .object({
    kind: z.literal('workspace-prepared'),
    binding: ExecutionAttemptWorkspaceBindingSchema,
  })
  .strict();

/** Terminal runtime outcome or opaque adapter result, never a product Job disposition. */
export const ExecutionAttemptOutcomeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('technical-failure'),
      stage: z.enum(['startup', 'workspace-preparation', 'workload-invocation']),
      /** Bounded, non-secret diagnostics suitable for durable storage. */
      message: z.string().min(1).max(8192),
    })
    .strict(),
  z.object({ kind: z.literal('workload-result'), result: JsonValueSchema }).strict(),
  // Reports that cooperative runtime work has stopped, not a request to cancel it.
  z.object({ kind: z.literal('cancelled'), reason: z.string().min(1).max(8192).optional() }).strict(),
]);

/** Frozen setup command interpreted locally by the Worker Runtime. */
export type WorkspaceSetupCommand = z.infer<typeof WorkspaceSetupCommandSchema>;
/** Portable optional Workspace requirement. */
export type WorkspaceRequirement = z.infer<typeof WorkspaceRequirementSchema>;
/** Preservation obligations checked before release. */
export type ExecutionPreservationRequirements = z.infer<typeof ExecutionPreservationRequirementsSchema>;
/** Immutable owner-supplied instruction. */
export type ExecutionAttemptInstruction = z.infer<typeof ExecutionAttemptInstructionSchema>;
/** Local binding scoped by the report's Attempt/runtime generation. */
export type ExecutionAttemptWorkspaceBinding = z.infer<typeof ExecutionAttemptWorkspaceBindingSchema>;
/** Semantic success result accepted atomically with Preparation completion. */
export type ExecutionAttemptPreparationResult = z.infer<typeof ExecutionAttemptPreparationResultSchema>;
/** Terminal result interpreted by the owner-side adapter. */
export type ExecutionAttemptOutcome = z.infer<typeof ExecutionAttemptOutcomeSchema>;
