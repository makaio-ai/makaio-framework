import { z } from 'zod';

/** Terminal execution states persisted by workflow finalization storage. */
export const WorkflowTerminalStatusSchema = z.enum(['completed', 'failed', 'cancelled']);

/** Durable terminal state selected before lifecycle finalization settles. */
export const WorkflowFinalizationIntentSchema = z
  .object({
    status: WorkflowTerminalStatusSchema,
    completedAt: z.number().int().nonnegative(),
    error: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

/** Stable identity stored with a workflow finalization claim. */
export const WorkflowFinalizerIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, 'Workflow finalizer IDs must be lowercase names.');

export type WorkflowTerminalStatus = z.infer<typeof WorkflowTerminalStatusSchema>;
export type WorkflowFinalizationIntent = z.infer<typeof WorkflowFinalizationIntentSchema>;
