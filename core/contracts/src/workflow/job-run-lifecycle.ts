import { z } from 'zod';

/** Zod schema for {@link JobRunLifecycleState}. */
export const JobRunLifecycleStateSchema = z.enum(['ordered', 'running', 'completed', 'lost', 'cancelled']);

/**
 * Life cycle state of a job run.
 *
 * The life cycle is not the outcome of the workflow. The outcome is the status
 * of the workflow result. A run that delivered a result with the outcome
 * `completed` or `failed` is `completed`: a failed workflow is an outcome, not
 * a state.
 */
export type JobRunLifecycleState = z.infer<typeof JobRunLifecycleStateSchema>;
