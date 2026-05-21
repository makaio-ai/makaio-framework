import { z } from 'zod';

/**
 * Zod schema for a CI/CD check run.
 *
 * Represents the status of a CI/CD pipeline or workflow check.
 */
export const VCSCheckRunSchema = z.object({
  /** Unique identifier for the check run */
  id: z.number(),
  /** Check name (e.g., 'lint', 'test', 'build') */
  name: z.string(),
  /** Current status of the check */
  status: z.enum(['queued', 'in_progress', 'completed']),
  /** Final conclusion (null if not completed) */
  conclusion: z
    .enum(['success', 'failure', 'neutral', 'cancelled', 'skipped', 'timed_out', 'action_required'])
    .nullable(),
  /** ISO timestamp when check started */
  startedAt: z.string().nullable(),
  /** ISO timestamp when check completed */
  completedAt: z.string().nullable(),
  /** URL to view the check details */
  url: z.string(),
  /** Workflow name (for GitHub Actions) */
  workflowName: z.string().optional(),
  /** Job name within the workflow */
  jobName: z.string().optional(),
});

/**
 * Inferred TypeScript type for VCS check runs.
 */
export type VCSCheckRun = z.infer<typeof VCSCheckRunSchema>;
