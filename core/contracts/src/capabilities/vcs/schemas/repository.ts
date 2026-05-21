import { z } from 'zod';

/**
 * Zod schema for VCS repository information.
 *
 * Represents a source control repository with its metadata.
 */
export const VCSRepositorySchema = z.object({
  /** VCS provider identifier (e.g., 'github', 'gitlab', 'bitbucket') */
  provider: z.string(),
  /** Repository owner or organization name */
  owner: z.string(),
  /** Repository name */
  repo: z.string(),
  /** Repository URL */
  url: z.string(),
  /** Default branch name (e.g., 'main', 'master') */
  defaultBranch: z.string().optional(),
});

/**
 * Inferred TypeScript type for VCS repository.
 */
export type VCSRepository = z.infer<typeof VCSRepositorySchema>;
