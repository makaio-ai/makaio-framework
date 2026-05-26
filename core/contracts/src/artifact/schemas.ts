import { z } from 'zod';

/**
 * Artifact type discriminator.
 * Common types: 'plan', 'review', 'summary', or custom strings.
 */
export const ArtifactTypeSchema = z.string().min(1);

/**
 * Framework-level artifact scope.
 *
 * The framework defines the two scopes that exist without product concepts:
 * - `session` — tied to an agent session
 * - `global` — shared across sessions
 *
 * Product extensions may widen this to include domain-specific scopes
 * (e.g., project, workstream, worktree) via schema extension.
 */
export const ArtifactScopeSchema = z.enum(['global', 'session']);

/**
 * Base object shape for core artifacts.
 *
 * Downstream schemas may replace `scope` before applying their own
 * scope-specific identifier invariants.
 */
export const ArtifactBaseSchema = z.object({
  /** Unique identifier (nanoid). */
  id: z.string(),

  /** Session this artifact belongs to (required for session-scoped artifacts). */
  sessionId: z.string().optional(),

  /** Scope level of this artifact. */
  scope: ArtifactScopeSchema,

  /** Artifact type (e.g., 'plan', 'review', 'summary'). */
  type: ArtifactTypeSchema,

  /** MIME type for content interpretation. */
  mimeType: z.string(),

  /** File path if artifact is file-backed. */
  filePath: z.string().optional(),

  /** Inline content if not file-backed. */
  content: z.string().optional(),

  /** Extensible metadata. */
  metadata: z.record(z.string(), z.unknown()),

  /** Creation timestamp. */
  createdAt: z.number(),

  /** Last modification timestamp. */
  updatedAt: z.number(),
});

/**
 * Core artifact data model.
 *
 * Represents a content artifact produced during agent sessions.
 * Product extensions extend this with additional scope identifiers
 * and domain-specific fields.
 */
export const ArtifactSchema = ArtifactBaseSchema.superRefine((data, ctx) => {
  if (data.scope === 'session' && !data.sessionId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sessionId'],
      message: 'Session-scoped artifacts require sessionId',
    });
  }
});

/**
 * Common body fields for creating an artifact.
 * Reusable across scope-specific create RPC variants.
 */
export const ArtifactCreateBodySchema = z.object({
  /** Artifact type. Must be non-empty. */
  type: z.string().min(1),

  /** MIME type for content interpretation. Defaults to `text/markdown` when omitted. */
  mimeType: z.string().optional(),

  /** Inline content for non-file-backed artifacts. */
  content: z.string().optional(),

  /** Display hint for the originating file path. */
  filePath: z.string().optional(),

  /** Extensible metadata record. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Artifact filter schema for querying artifacts by type or MIME type.
 */
export const ArtifactFilterSchema = z.object({
  /** Filter by artifact type. */
  type: ArtifactTypeSchema.optional(),

  /** Filter by MIME type. */
  mimeType: z.string().optional(),
});

/**
 * Artifact changes schema — which fields were modified in an update.
 */
export const ArtifactChangesSchema = z.object({
  /** Updated metadata (merged with existing). */
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/** Artifact type (e.g., 'plan', 'review', 'summary'). */
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

/** Framework-level artifact scope. */
export type ArtifactScope = z.infer<typeof ArtifactScopeSchema>;

/** Base object shape for core artifacts. */
export type ArtifactBase = z.infer<typeof ArtifactBaseSchema>;

/** Core artifact data model. */
export type Artifact = z.infer<typeof ArtifactSchema>;

/** Common create body fields. */
export type ArtifactCreateBody = z.infer<typeof ArtifactCreateBodySchema>;

/** Filter criteria for artifact queries. */
export type ArtifactFilter = z.infer<typeof ArtifactFilterSchema>;

/** Changes made to an artifact during update. */
export type ArtifactChanges = z.infer<typeof ArtifactChangesSchema>;
