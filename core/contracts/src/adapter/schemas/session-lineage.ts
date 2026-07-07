import { z } from 'zod';

/** Closed set of adapter session lineage kinds. */
export const SESSION_LINEAGE_KINDS = ['root', 'fork', 'subagent', 'compress'] as const;
/** Canonical root lineage literal. */
export const ROOT_SESSION_LINEAGE_KIND = 'root' as const;
/** Canonical fork lineage literal. */
export const FORK_SESSION_LINEAGE_KIND = 'fork' as const;
/** Canonical subagent lineage literal. */
export const SUBAGENT_SESSION_LINEAGE_KIND = 'subagent' as const;
/** Canonical compress lineage literal. */
export const COMPRESS_SESSION_LINEAGE_KIND = 'compress' as const;

/** Discriminates the relationship of a session to its parent. */
export const SessionLineageKindSchema = z.enum(SESSION_LINEAGE_KINDS);
export type SessionLineageKind = z.infer<typeof SessionLineageKindSchema>;

/**
 * Canonical lineage contract for adapter sessions.
 * Reusable by any adapter with fork/subagent concepts.
 */
export const RootSessionLineageSchema = z.object({
  /** Relationship to parent: standalone root session. */
  kind: z.literal(ROOT_SESSION_LINEAGE_KIND),
  /** Root sessions never reference a parent adapter session. */
  parentAdapterSessionId: z.null(),
  /** Root sessions never reference a fork point. */
  forkPointMessageId: z.null(),
});

export const ForkSessionLineageSchema = z.object({
  /** Relationship to parent: user-created fork from another session. */
  kind: z.literal(FORK_SESSION_LINEAGE_KIND),
  /** Forks must reference a parent adapter session. */
  parentAdapterSessionId: z.string(),
  /**
   * Message id at the fork divergence point.
   *
   * Nullable because hook-first fork registration precedes transcript
   * analysis: the SessionStart hook knows the parent but cannot yet
   * identify the fork point message. The transcript import fills this
   * value exactly once via fill-once enrichment semantics.
   */
  forkPointMessageId: z.string().nullable(),
});

export const SubagentSessionLineageSchema = z.object({
  /** Relationship to parent: subagent spawned from a parent session. */
  kind: z.literal(SUBAGENT_SESSION_LINEAGE_KIND),
  /** Subagents must reference their parent adapter session. */
  parentAdapterSessionId: z.string(),
  /** Subagents do not fork at a message boundary. */
  forkPointMessageId: z.null(),
});

export const CompressSessionLineageSchema = z.object({
  /** Relationship to parent: context compression from a parent session. */
  kind: z.literal(COMPRESS_SESSION_LINEAGE_KIND),
  /** Compress children must reference their parent adapter session. */
  parentAdapterSessionId: z.string(),
  /** Compress children do not fork at a specific message boundary. */
  forkPointMessageId: z.null(),
});

export const SessionLineageSchema = z.discriminatedUnion('kind', [
  RootSessionLineageSchema,
  ForkSessionLineageSchema,
  SubagentSessionLineageSchema,
  CompressSessionLineageSchema,
]);

export type SessionLineage = z.infer<typeof SessionLineageSchema>;
