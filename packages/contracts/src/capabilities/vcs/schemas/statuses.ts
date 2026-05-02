import { z } from 'zod';

/**
 * Zod schema for a commit status from the legacy status API.
 *
 * Represents external tool statuses (CodeRabbit, CI systems) reported via
 * the commit status API rather than the check runs API.
 */
export const VCSCommitStatusSchema = z.object({
  /** Status ID */
  id: z.number(),
  /** Status state */
  state: z.enum(['error', 'failure', 'pending', 'success']),
  /** Short description */
  description: z.string().nullable(),
  /** URL for details */
  targetUrl: z.string().url().nullable(),
  /** Status context (e.g., 'coderabbitai/pr-reviewer') */
  context: z.string(),
  /** ISO timestamp when created */
  createdAt: z.string().datetime(),
  /** ISO timestamp when last updated */
  updatedAt: z.string().datetime(),
  /** Username of the status creator */
  creator: z.string().nullable(),
});

/**
 * Inferred TypeScript type for VCS commit statuses.
 */
export type VCSCommitStatus = z.infer<typeof VCSCommitStatusSchema>;
