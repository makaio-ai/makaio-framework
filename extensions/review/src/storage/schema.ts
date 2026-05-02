import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

/**
 * Review findings table.
 * Stores lifecycle-tracked findings from external reviewers and agents.
 */
export const reviewFindings = sqliteTable(
  'extension_review_findings',
  {
    id: text('id').primaryKey(),
    repository: text('repository').notNull(),
    prNumber: integer('pr_number'),
    branch: text('branch'),
    headSha: text('head_sha'),
    sourceId: text('source_id').notNull(),
    reviewer: text('reviewer').notNull(),
    origin: text('origin').notNull(),
    threadId: text('thread_id'),
    severity: text('severity').notNull(),
    file: text('file'),
    startLine: integer('start_line'),
    endLine: integer('end_line'),
    message: text('message').notNull(),
    agentPrompt: text('agent_prompt'),
    /** JSON-serialised SuggestedChange[]. */
    suggestedChanges: text('suggested_changes').notNull(),
    status: text('status').notNull(),
    addressedBy: text('addressed_by'),
    addressedAt: integer('addressed_at'),
    verifiedAt: integer('verified_at'),
    dismissedReason: text('dismissed_reason'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    rawCommentId: integer('raw_comment_id'),
  },
  (table) => [
    index('idx_review_findings_repo_pr').on(table.repository, table.prNumber),
    index('idx_review_findings_status').on(table.status),
    index('idx_review_findings_reviewer').on(table.reviewer),
    index('idx_review_findings_source').on(table.sourceId),
  ],
);

export type SelectReviewFinding = typeof reviewFindings.$inferSelect;
export type InsertReviewFinding = typeof reviewFindings.$inferInsert;
