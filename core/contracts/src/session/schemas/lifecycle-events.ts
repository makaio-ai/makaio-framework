/* eslint max-lines: ["error", { "max": 448 }] */
import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { ForkChildInfoSchema } from './fork-child-info.js';
import { BranchKindSchema } from './primitives.js';

/**
 * Session lifecycle event schemas.
 * These extend SessionSchemas for fork/merge/abandon lifecycle.
 */

// ============================================================================
// Segment Policy Schema
// ============================================================================

/**
 * Policy for a contiguous range of messages in a fork context window.
 *
 * Segments define how a slice of conversation history is projected into the
 * child session. When `segments` is present on {@link ForkTransforms},
 * `removedMessageIds` and `appliedPipeline` are ignored — segments take
 * precedence as the authoritative context curation strategy.
 */
export const SegmentPolicySchema = z.object({
  /** Start message ID (inclusive) */
  fromMessageId: z.string(),
  /** End message ID (inclusive) */
  toMessageId: z.string(),
  /** Base policy for this segment */
  policy: z.enum(['verbatim', 'summarize', 'exclude']),
  /** Strip reasoning blocks; applies to verbatim and summarize policies */
  stripReasoning: z.boolean().optional(),
  /** Strip tool output blocks; applies to verbatim and summarize policies */
  stripToolOutputs: z.boolean().optional(),
  /** Per-message overrides within the segment */
  overrides: z.record(z.string(), z.literal('exclude')).optional(),
  /** Pre-generated summary text (for summarize policy, stored after preview) */
  summaryText: z.string().optional(),
});

/** Inferred type for {@link SegmentPolicySchema}. */
export type SegmentPolicy = z.infer<typeof SegmentPolicySchema>;

// ============================================================================
// Fork Transforms Schema
// ============================================================================

/**
 * Transform configuration for fork sessions.
 * Stored on session record and applied by getFullConversation().
 *
 * When `segments` is present, it takes precedence over `removedMessageIds`
 * and `appliedPipeline` — those fields are ignored at runtime.
 */
export const ForkTransformsSchema = z.object({
  /** Message IDs to exclude from projected context */
  removedMessageIds: z.array(z.string()).optional(),
  /** Pipeline steps to apply (must be 'transformation' category) */
  appliedPipeline: z
    .array(
      z.object({
        actionId: z.string(),
        options: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
  /**
   * Segment-based context curation policies.
   * When present, supersedes removedMessageIds and appliedPipeline.
   */
  segments: z.array(SegmentPolicySchema).optional(),
});

export type ForkTransforms = z.infer<typeof ForkTransformsSchema>;

// ============================================================================
// Merge RPC
// ============================================================================

export const MergeRequestSchema = z.object({
  /** Parent session (receives the merge) */
  parentSessionId: z.string(),
  /** Child session to merge */
  childSessionId: z.string(),
  /** Optional explicit summary (else auto-generated) */
  summary: z.string().optional(),
  /** Source of the request */
  source: z.enum(['extension', 'user', 'system']).optional(),
  /** Extension ID if source is 'extension' */
  extensionId: z.string().optional(),
});

export const MergeResponseSchema = z.object({
  /** Whether merge succeeded */
  success: z.boolean(),
  /** Final handoff summary injected into parent */
  handoff: z.string().optional(),
});

// ============================================================================
// Abandon RPC
// ============================================================================

export const AbandonRequestSchema = z.object({
  /** Parent session */
  parentSessionId: z.string(),
  /** Child session to abandon */
  childSessionId: z.string(),
  /** Source of the request */
  source: z.enum(['extension', 'user', 'system']).optional(),
  /** Extension ID if source is 'extension' */
  extensionId: z.string().optional(),
});

export const AbandonResponseSchema = z.object({
  /** Whether abandon succeeded */
  success: z.boolean(),
});

// ============================================================================
// GetChildren RPC
// ============================================================================

export const GetChildrenRequestSchema = z.object({
  /** Session to get children for */
  sessionId: z.string(),
});

export const GetChildrenResponseSchema = z.object({
  /** Enriched child session info */
  children: z.array(ForkChildInfoSchema),
});

// ============================================================================
// Lifecycle Events (fire-and-forget)
// ============================================================================

export const ForkingEventSchema = z.object({
  parentSessionId: z.string(),
  childSessionId: z.string(),
  reason: z.string(),
});

export const ForkedEventSchema = z.object({
  parentSessionId: z.string(),
  childSessionId: z.string(),
  forkPoint: z.string().optional(),
});

export const MergingEventSchema = z.object({
  parentSessionId: z.string(),
  childSessionId: z.string(),
});

export const MergedEventSchema = z.object({
  parentSessionId: z.string(),
  childSessionId: z.string(),
  handoff: z.string(),
});

export const AbandonedEventSchema = z.object({
  sessionId: z.string(),
  parentSessionId: z.string().optional(),
});

export const ChildCompletedEventSchema = z.object({
  parentSessionId: z.string(),
  childSessionId: z.string(),
  result: z.unknown(),
});

export const CompressionRequestedEventSchema = z.object({
  sessionId: z.string(),
  reason: z.string(),
  source: z.enum(['extension', 'user', 'system']).optional(),
  extensionId: z.string().optional(),
});

// ============================================================================
// Compress RPC
// ============================================================================

export const CompressRequestSchema = z.object({
  /** Session to compress */
  sessionId: z.string(),
  /** Pipeline steps to execute */
  pipeline: z.array(
    z.object({
      actionId: z.string(),
      options: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

export const CompressResponseSchema = z.object({
  /** ID of the squash event created */
  eventId: z.string(),
  /** Context JSON produced by pipeline */
  contextJson: z.record(z.string(), z.unknown()),
  /** Token count before compression */
  tokensBefore: z.number(),
  /** Token count after compression */
  tokensAfter: z.number().optional(),
});

// ============================================================================
// Bus-oriented branch events (persisted to session-event storage)
//
// NOTE: These schemas include `sessionId` at the top level for bus routing.
// The corresponding storage schemas in event.ts define payloads without
// sessionId (it's on the event envelope). The session service's lifecycle
// event writers bridge between them:
// - Receive the bus event with sessionId in the payload
// - Create a MakaioSessionEvent with sessionId on the envelope, payload from the event
//
// Payload fields here should match event.ts payload shapes (excluding sessionId).
// ============================================================================

export const BranchCreatedEventSchema = z.object({
  /** Session this event belongs to (the parent session) */
  sessionId: z.string(),
  /** The session that was created */
  childSessionId: z.string(),
  /** The parent session it branched from */
  parentSessionId: z.string(),
  /** Type of branch */
  kind: BranchKindSchema,
  /** Message ID where the branch diverged (last shared message) */
  forkPointMessageId: z.string().optional(),
  /** Audit trail: transforms requested at fork time */
  transforms: ForkTransformsSchema.optional(),
});

export const BranchMergedEventSchema = z.object({
  /** Session this event belongs to (the parent session) */
  sessionId: z.string(),
  /** The branch session that was merged */
  childSessionId: z.string(),
  /** The parent session it merged into */
  parentSessionId: z.string(),
  /** Summary/result injected into parent (JSON string) */
  resultJson: z.string().optional(),
  /** Message ID of the injected summary in parent session */
  resultMessageId: z.string().optional(),
});

export const SquashEventSchema = z.object({
  /** Session this event belongs to */
  sessionId: z.string(),
  /** Structured summary JSON that replaces prior context */
  summaryJson: z.string(),
  /** Token count before compression */
  tokensBefore: z.number().optional(),
  /** Token count after compression */
  tokensAfter: z.number().optional(),
  /** Message IDs that were compressed (for audit) */
  compressedMessageIds: z.array(z.string()).optional(),
});

export const SessionCreatedEventSchema = z.object({
  /** The session that was created */
  sessionId: z.string(),
  /** The parent session if this is a branch */
  parentSessionId: z.string().nullable(),
  /** Type of branch if applicable */
  branchKind: BranchKindSchema.nullable(),
  /** Timestamp when the session was created */
  createdAt: z.number(),
  /**
   * Window ID that initiated the session creation.
   * Preserved as creation provenance for the originating tab.
   * Absent for backend-originated sessions (e.g., discovery).
   */
  originWindowId: z.string().optional(),
});

export const SessionUpdatedEventSchema = z.object({
  /** Session that was updated */
  sessionId: z.string(),
  /** Which properties changed */
  changedProperties: z.array(z.string()),
});

// ============================================================================
// Lifecycle Schemas Object (spread into SessionSchemas)
// ============================================================================

/**
 * Lifecycle schemas for session fork/merge/abandon operations.
 *
 * These schemas are spread into SessionSchemas, similar to OrchestratorSchemas.
 * Subjects become: `session.{key}`
 */
export const LifecycleSchemas = {
  /**
   * Merge a child session into parent.
   * Subject: `session.merge`
   * Type: Request (RPC)
   */
  merge: {
    request: MergeRequestSchema,
    response: MergeResponseSchema,
  },

  /**
   * Abandon a child session without merging.
   * Subject: `session.abandon`
   * Type: Request (RPC)
   */
  abandon: {
    request: AbandonRequestSchema,
    response: AbandonResponseSchema,
  },

  /**
   * Get child sessions of a parent.
   * Subject: `session.getChildren`
   * Type: Request (RPC)
   */
  getChildren: {
    request: GetChildrenRequestSchema,
    response: GetChildrenResponseSchema,
  },

  /**
   * Emitted when fork is about to happen.
   * Subject: `session.forking`
   */
  forking: ForkingEventSchema,

  /**
   * Emitted after fork completes.
   * Subject: `session.forked`
   */
  forked: ForkedEventSchema,

  /**
   * Emitted when merge is about to happen.
   * Subject: `session.merging`
   */
  merging: MergingEventSchema,

  /**
   * Emitted after merge completes.
   * Subject: `session.merged`
   */
  merged: MergedEventSchema,

  /**
   * Emitted when session is abandoned.
   * Subject: `session.abandoned`
   */
  abandoned: AbandonedEventSchema,

  /**
   * Emitted when a child session completes.
   * Subject: `session.childCompleted`
   */
  childCompleted: ChildCompletedEventSchema,

  /**
   * Compression requested for a session.
   * Subject: `session.compressionRequested`
   */
  compressionRequested: CompressionRequestedEventSchema,

  /**
   * Branch created event (persisted to session-event storage).
   * Subject: `session.branch.created`
   * Type: Event (fire-and-forget)
   *
   * Emitted by fork handler. The session service's lifecycle event writers
   * subscribe and persist with transform applied (e.g., PII redaction).
   */
  'branch.created': BranchCreatedEventSchema,

  /**
   * Branch merged event.
   * Subject: `session.branch.merged`
   * Type: Event (fire-and-forget)
   *
   * Emitted by the merge handler, which owns idempotent persistence of the
   * corresponding session-event row directly (stable eventId).
   */
  'branch.merged': BranchMergedEventSchema,

  /**
   * Context squash event.
   * Subject: `session.squash`
   * Type: Event (fire-and-forget)
   *
   * Emitted when context is compressed. The compress handler owns idempotent
   * persistence of the corresponding session-event row directly (stable eventId).
   */
  squash: SquashEventSchema,

  /**
   * Session created event.
   * Subject: `session.created`
   * Type: Event (fire-and-forget)
   *
   * Emitted when a new session is created (session.create handler and the
   * import/registration seams). Consumed for entity-cache reactivity.
   */
  created: SessionCreatedEventSchema,

  /**
   * Session property updated event.
   * Subject: `session.updated`
   * Type: Event (fire-and-forget)
   *
   * Emitted after a session update (e.g., title, status change).
   * Entity cache subscribes to re-fetch updated session data.
   */
  updated: SessionUpdatedEventSchema,

  /**
   * Compress session context via pipeline.
   * Subject: `session.compress`
   * Type: Request (RPC)
   */
  compress: {
    request: CompressRequestSchema,
    response: CompressResponseSchema,
  },
} satisfies SchemaRecord;

// Type Exports
export type MergeRequest = z.infer<typeof MergeRequestSchema>;
export type MergeResponse = z.infer<typeof MergeResponseSchema>;
export type AbandonRequest = z.infer<typeof AbandonRequestSchema>;
export type AbandonResponse = z.infer<typeof AbandonResponseSchema>;
export type GetChildrenRequest = z.infer<typeof GetChildrenRequestSchema>;
export type GetChildrenResponse = z.infer<typeof GetChildrenResponseSchema>;
export type ForkingEvent = z.infer<typeof ForkingEventSchema>;
export type ForkedEvent = z.infer<typeof ForkedEventSchema>;
export type MergingEvent = z.infer<typeof MergingEventSchema>;
export type MergedEvent = z.infer<typeof MergedEventSchema>;
export type AbandonedEvent = z.infer<typeof AbandonedEventSchema>;
export type ChildCompletedEvent = z.infer<typeof ChildCompletedEventSchema>;
export type CompressionRequestedEvent = z.infer<typeof CompressionRequestedEventSchema>;
export type CompressRequest = z.infer<typeof CompressRequestSchema>;
export type CompressResponse = z.infer<typeof CompressResponseSchema>;
export type BranchCreatedEvent = z.infer<typeof BranchCreatedEventSchema>;
export type BranchMergedEvent = z.infer<typeof BranchMergedEventSchema>;
export type SquashEvent = z.infer<typeof SquashEventSchema>;
export type SessionCreated = z.infer<typeof SessionCreatedEventSchema>;
export type SessionUpdatedEvent = z.infer<typeof SessionUpdatedEventSchema>;
