import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

// =============================================================================
// codebase.changed — Fully correlated fingerprint change event
// =============================================================================

/**
 * Emitted when a codebase fingerprint changes for a given scope.
 * Contains full organizational context (project, worktree, workstream).
 */
export const CodebaseChangedEventSchema = z.object({
  /** Filesystem path to the repo root */
  repoPath: z.string(),
  /** Fingerprint scope name (e.g., 'default', 'typecheck', 'lint') */
  scope: z.string(),
  /** Current content hash (SHA-256) */
  fingerprint: z.string(),
  /** Previous content hash (undefined on first computation) */
  previousFingerprint: z.string().optional(),
  /** File paths that triggered the recompute */
  changedPaths: z.array(z.string()),
  /** Current commit SHA */
  commitSha: z.string(),
  /** ISO 8601 timestamp */
  timestamp: z.iso.datetime(),

  // Resolved organizational context
  /** Project ID this change belongs to */
  projectId: z.string(),
  /** Git worktree name (if applicable) */
  worktree: z.string().optional(),
  /** Resolved worktree UUID */
  worktreeId: z.string().optional(),
  /** Resolved workstream UUID (from workstream_worktrees junction) */
  workstreamId: z.string().optional(),
});
export type CodebaseChangedEvent = z.infer<typeof CodebaseChangedEventSchema>;

/**
 * Codebase namespace schemas.
 *
 * This namespace emits content-aware fingerprint change events enriched
 * with organizational context (project, worktree, workstream).
 *
 * Seam: Add `codebase.getContext` RPC for on-demand fingerprint+context retrieval.
 */
export const CodebaseSchemas = {
  /** Emitted when codebase content changes for a scope */
  changed: CodebaseChangedEventSchema,
} satisfies SchemaRecord;
