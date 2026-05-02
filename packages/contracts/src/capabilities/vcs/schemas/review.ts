import { z } from 'zod';

/**
 * Zod schema for a review comment on code.
 *
 * Represents inline comments made during code review.
 */
export const VCSReviewCommentSchema = z.object({
  /** Unique identifier for the comment */
  id: z.number(),
  /** Username of the commenter */
  author: z.string(),
  /** Comment body text */
  body: z.string(),
  /** File path the comment is on (null for general PR comments) */
  path: z.string().nullable(),
  /** Line number (null for general PR comments) */
  line: z.number().nullable(),
  /** Diff hunk context for the comment (if available) */
  diffHunk: z.string().nullish(),
  /** ISO timestamp when comment was created */
  createdAt: z.string(),
  /** ISO timestamp when comment was last updated */
  updatedAt: z.string(),
  /** ID of the parent comment if this is a reply */
  inReplyToId: z.number().nullable(),
  /** GraphQL node ID for thread operations (GitHub: PRRT_*) */
  threadId: z.string().nullish(),
  /** Whether this comment's thread is resolved */
  isResolved: z.boolean().nullish(),
});

/**
 * Inferred TypeScript type for VCS review comments.
 */
export type VCSReviewComment = z.infer<typeof VCSReviewCommentSchema>;
