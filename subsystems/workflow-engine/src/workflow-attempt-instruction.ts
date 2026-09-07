import { z } from 'zod';
import {
  ExecutionAttemptInstructionSchema,
  WorkflowRunContextSchema,
  type ExecutionAttemptInstruction,
  type ExecutionPreservationRequirements,
  type WorkflowRunContext,
  type WorkflowWorkerConfig,
  type WorkspaceRequirement,
} from '@makaio/contracts';

/** Installed adapter that interprets portable workflow invocation input. */
export const WORKFLOW_WORKLOAD_KIND = 'workflow';
/** Version of the workflow adapter's frozen input contract. */
export const WORKFLOW_WORKLOAD_VERSION = '1';

const contextFields = WorkflowRunContextSchema.shape;

/**
 * Immutable workflow semantics, independent of the selected Worker Runtime.
 *
 * Environment values, contribution packages, and provider suspension behavior
 * are runtime inputs. Executable acquisition remains in this adapter payload;
 * it does not implicitly request a project Workspace.
 */
export const WorkflowInvocationInputSchema = z
  .object({
    executionId: contextFields.executionId,
    workflowId: contextFields.workflowId,
    source: contextFields.source,
    definitionSnapshot: contextFields.definitionSnapshot,
    inputs: contextFields.inputs,
    config: contextFields.config,
    scope: contextFields.scope,
    triggerPayload: contextFields.triggerPayload,
    triggerMode: contextFields.triggerMode,
    artifactRef: contextFields.artifactRef,
    coordinatorSessionId: contextFields.coordinatorSessionId,
    cancelSubject: contextFields.cancelSubject,
    materializationSpec: contextFields.materializationSpec,
    terminalAuthority: z.literal('authority'),
  })
  .strict()
  .superRefine((input, ctx) => {
    // Reuse the workflow contract's source/definition/materialization rules.
    // The timestamp only satisfies that older context shape; it is not input.
    const context = WorkflowRunContextSchema.safeParse({ ...input, createdAt: 0 });
    if (!context.success) {
      for (const issue of context.error.issues) {
        ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
      }
    }
    // The inherited source schema already rejects absolute POSIX paths. This
    // adds traversal, backslash, and drive-relative rejection to that contract.
    if (
      input.source.kind === 'path' &&
      (input.source.path.includes('\\') ||
        /^[A-Za-z]:/.test(input.source.path) ||
        input.source.path.split('/').includes('..'))
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['source', 'path'],
        message: 'Workflow source must stay within its executable root',
      });
    }
    if (input.source.kind === 'definition' && input.source.workflowId !== input.workflowId) {
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'Workflow source identity does not match the invocation',
      });
    }
    if (input.definitionSnapshot !== undefined && input.definitionSnapshot.id !== input.workflowId) {
      ctx.addIssue({
        code: 'custom',
        path: ['definitionSnapshot'],
        message: 'Workflow definition identity does not match the invocation',
      });
    }
  });

/** Portable input understood exclusively by the workflow workload adapter. */
export type WorkflowInvocationInput = z.infer<typeof WorkflowInvocationInputSchema>;

/** Owner inputs for freezing one workflow assignment before Attempt dispatch. */
export interface BuildWorkflowAttemptInstructionOptions {
  /** Identity assigned by the execution owner to this instruction. */
  readonly id: string;
  /** Revision assigned by the execution owner before Attempt creation. */
  readonly revision: string;
  /** Runner configuration; transport credentials and environment are never copied. */
  readonly config: WorkflowWorkerConfig;
  /** Portable owner snapshot, required when runner config names a local executable path. */
  readonly runContext?: WorkflowRunContext;
  /** Optional project working area, independent of workflow executable acquisition. */
  readonly workspace?: WorkspaceRequirement;
  /** Explicit preservation obligations; an empty list declares scratch work. */
  readonly preservation: ExecutionPreservationRequirements;
}

/**
 * Select portable workflow fields from an owner context or self-contained config.
 * @param config - Runner configuration used for self-contained execution.
 * @param runContext - Portable owner context when one exists.
 * @returns Detached workflow input without transport or selected runtime fields.
 */
function selectInvocationInput(
  config: WorkflowWorkerConfig,
  runContext: WorkflowRunContext | undefined,
): WorkflowInvocationInput {
  if (runContext === undefined && config.source.kind === 'path') {
    throw new Error('Path-backed workflow instructions require a portable run context');
  }
  if (
    runContext !== undefined &&
    (runContext.executionId !== config.executionId || runContext.workflowId !== config.workflowId)
  ) {
    throw new Error('Workflow run context does not belong to the dispatched execution');
  }
  const source = runContext ?? config;
  const definitionSnapshot = runContext === undefined ? config.definition : runContext.definitionSnapshot;
  return WorkflowInvocationInputSchema.parse({
    executionId: source.executionId,
    workflowId: source.workflowId,
    source: source.source,
    ...(definitionSnapshot !== undefined ? { definitionSnapshot } : {}),
    inputs: source.inputs,
    ...(source.config !== undefined ? { config: source.config } : {}),
    scope: source.scope,
    triggerPayload: source.triggerPayload,
    ...(source.triggerMode !== undefined ? { triggerMode: source.triggerMode } : {}),
    ...(source.artifactRef !== undefined ? { artifactRef: source.artifactRef } : {}),
    coordinatorSessionId: source.coordinatorSessionId,
    cancelSubject: source.cancelSubject,
    ...(source.materializationSpec !== undefined ? { materializationSpec: source.materializationSpec } : {}),
    terminalAuthority: 'authority',
  });
}

/**
 * Freeze workflow semantics without persisting a worker config or local paths.
 * @param options - Instruction identity, portable workflow input, and explicit resource requirements.
 * @returns A detached instruction suitable for Authority-owned Attempt creation.
 */
export function buildWorkflowAttemptInstruction(
  options: BuildWorkflowAttemptInstructionOptions,
): ExecutionAttemptInstruction {
  const input = selectInvocationInput(options.config, options.runContext);
  // Validate the typed workflow first: opaque user values must already be JSON.
  // SQLite-decoded definitions retain explicit undefined optional properties;
  // serialization omits those absent fields before the generic JSON boundary.
  const portableInput: unknown = JSON.parse(JSON.stringify(input));
  return ExecutionAttemptInstructionSchema.parse({
    id: options.id,
    revision: options.revision,
    workload: {
      kind: WORKFLOW_WORKLOAD_KIND,
      version: WORKFLOW_WORKLOAD_VERSION,
      input: portableInput,
    },
    ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
    preservation: options.preservation,
  });
}

/**
 * Parse an assignment at the workflow adapter boundary.
 * @param instruction - Frozen generic Attempt instruction.
 * @returns The workflow adapter's portable input.
 * @throws When the instruction requires another adapter or input version.
 */
export function parseWorkflowAttemptInstruction(instruction: ExecutionAttemptInstruction): WorkflowInvocationInput {
  if (
    instruction.workload.kind !== WORKFLOW_WORKLOAD_KIND ||
    instruction.workload.version !== WORKFLOW_WORKLOAD_VERSION
  ) {
    throw new Error('Instruction does not target the supported workflow workload adapter');
  }
  return WorkflowInvocationInputSchema.parse(instruction.workload.input);
}
