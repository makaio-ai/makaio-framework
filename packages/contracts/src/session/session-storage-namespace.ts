import { z } from 'zod';
import { createStorageNamespace } from '@makaio/storage-core';
import { MakaioSessionSchema } from './schemas.js';
import { ApprovalPolicySchema } from '../harness/schemas.js';
import { BranchKindSchema } from './schemas/primitives.js';
import { ForkChildInfoSchema } from './schemas/fork-child-info.js';
import { SessionPreviewDataSchema, SessionWithPreviewSchema } from './schemas/session.js';
import { ClientIdentityObservationSchema } from '../client/account-identity.js';

/**
 * Session preview for search results (always includes preview).
 */
const SessionSearchResultSchema = MakaioSessionSchema.extend({
  preview: SessionPreviewDataSchema,
});

/**
 * Enforce that canonical client-account writes always carry observation evidence.
 * @param value - Candidate storage payload containing client-account fields
 * @param ctx - Zod refinement context
 */
function validateClientAccountObservationRequirement(
  value: {
    clientId?: string;
    clientAccountId?: string;
    lastClientIdentityObservation?: unknown;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.clientAccountId !== undefined && value.lastClientIdentityObservation === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['lastClientIdentityObservation'],
      message: 'lastClientIdentityObservation is required when clientAccountId is provided',
    });
  }

  if (value.clientAccountId !== undefined && value.clientId === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['clientId'],
      message: 'clientId is required when clientAccountId is provided',
    });
  }
}

export const SessionStorageSetSessionSchema = MakaioSessionSchema.superRefine((value, ctx) => {
  validateClientAccountObservationRequirement(value, ctx);
});

export const SessionStorageSetRequestSchema = z
  .object({
    sessionId: z.string(),
    session: SessionStorageSetSessionSchema,
    /** Only insert if session does not exist (no overwrite). */
    ifAbsent: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.sessionId !== value.session.sessionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['session', 'sessionId'],
        message: 'session.sessionId must match the top-level sessionId',
      });
    }
  });

const SessionStorageUpdateRequestPayloadSchema = z.object({
  sessionId: z.string(),
  status: z.enum(['active', 'closed', 'archived', 'discovered']).optional(),
  parentSessionId: z.string().optional(),
  rootSessionId: z.string().optional(),
  forkPointMessageId: z.string().optional(),
  branchKind: BranchKindSchema.optional(),
  isOrchestrated: z.boolean().optional(),
  clientId: z.string().optional(),
  clientAccountId: z.string().optional(),
  lastClientIdentityObservation: ClientIdentityObservationSchema.optional(),
  executionTargetId: z.string().nullable().optional(),
  approvalPolicyOverride: ApprovalPolicySchema.nullable().optional(),
  title: z.string().optional(),
  targetWorkingDirectory: z.string().optional(),
  createdAt: z.number().finite().optional(),
  lastActivityAt: z.number().finite().optional(),
  spawningToolCallId: z.string().nullable().optional(),
});
// Intentionally no `validateClientAccountObservationRequirement(...)` here:
// partial updates have no previous-row context, so the authoritative transition
// invariant is enforced in storage handlers after loading the persisted session.

/**
 * Request and response schema for storage:session.update.
 */
export const SessionStorageUpdateSchema = {
  request: SessionStorageUpdateRequestPayloadSchema,
  response: z.object({
    success: z.boolean(),
    clientAccountChanged: z.boolean().optional(),
  }),
};

/**
 * Session storage namespace.
 *
 * Provides bus subjects for session CRUD operations.
 * Registered under `storage:session` on the Makaio bus.
 *
 * Storage backends register handlers; consumers communicate through
 * subjects only, never importing directly from storage implementations.
 * @example
 * ```typescript
 * import { SessionStorageSubjects } from '@makaio/contracts';
 *
 * const { session } = await bus.request(SessionStorageSubjects.get, { sessionId: '123' });
 * const { sessions } = await bus.request(SessionStorageSubjects.list, { status: 'active' });
 * ```
 */
export const SessionStorageNamespace = createStorageNamespace('session', {
  schemas: {
    /**
     * Get a session by ID.
     *
     * Subject: `storage:session.get`
     * Type: Request (RPC)
     */
    get: {
      request: z.object({
        sessionId: z.string(),
      }),
      response: z.object({
        session: MakaioSessionSchema.nullable(),
      }),
    },

    /**
     * Store or update a session.
     *
     * Subject: `storage:session.set`
     * Type: Request (RPC)
     */
    set: {
      request: SessionStorageSetRequestSchema,
      response: z.object({
        success: z.boolean(),
        clientAccountChanged: z.boolean().optional(),
      }),
    },

    /**
     * Delete a session by ID.
     *
     * Subject: `storage:session.delete`
     * Type: Request (RPC)
     */
    delete: {
      request: z.object({
        sessionId: z.string(),
      }),
      response: z.object({
        success: z.boolean(),
      }),
    },

    /**
     * List sessions with optional status filter and preview data.
     *
     * Subject: `storage:session.list`
     * Type: Request (RPC)
     */
    list: {
      request: z.object({
        status: z.enum(['active', 'closed', 'archived', 'discovered', 'all']).optional(),
        limit: z.number().int().min(1).optional(),
        offset: z.number().int().min(0).optional(),
        /** Include preview data (messageCount, firstUserMessage) */
        includePreview: z.boolean().optional(),
        /** Filter by execution target ID (only sessions stamped with this target) */
        executionTargetId: z.string().optional(),
      }),
      response: z.object({
        sessions: z.array(SessionWithPreviewSchema),
        total: z.number(),
      }),
    },

    /**
     * List direct child sessions for a parent session.
     *
     * Subject: `storage:session.getChildren`
     * Type: Request (RPC)
     */
    getChildren: {
      request: z.object({
        sessionId: z.string(),
      }),
      response: z.object({
        children: z.array(ForkChildInfoSchema),
      }),
    },

    /**
     * Search sessions by content using FTS5.
     *
     * Subject: `storage:session.search`
     * Type: Request (RPC)
     */
    search: {
      request: z.object({
        query: z.string(),
        limit: z.number().int().min(1).optional(),
        status: z.enum(['active', 'closed', 'archived', 'discovered', 'all']).optional(),
        isImported: z.boolean().optional(),
      }),
      response: z.object({
        sessions: z.array(SessionSearchResultSchema),
        total: z.number(),
      }),
    },

    /**
     * Update specific fields of a session (partial update).
     *
     * Subject: `storage:session.update`
     * Type: Request (RPC)
     */
    update: SessionStorageUpdateSchema,

    /**
     * Get a session by its adapter session ID.
     *
     * Subject: `storage:session.getByAdapterSessionId`
     * Type: Request (RPC)
     */
    getByAdapterSessionId: {
      request: z.object({
        adapterSessionId: z.string(),
      }),
      response: z.object({
        session: MakaioSessionSchema.nullable(),
      }),
    },

    /**
     * Get session counts by status.
     *
     * Subject: `storage:session.getStatusCounts`
     * Type: Request (RPC)
     */
    getStatusCounts: {
      // z.object({}) is the established extensible-base pattern. The host
      // layer widens this to ScopedStorageStatusCounts (projectId/worktreeId)
      // via extendSubject(). z.strictObject({}) would break that seam.
      request: z.object({}),
      response: z.object({
        all: z.number(),
        active: z.number(),
        closed: z.number(),
        archived: z.number(),
        discovered: z.number(),
      }),
    },
  },
});

/**
 * Typed subjects for session storage bus operations.
 */
export const SessionStorageSubjects = SessionStorageNamespace.subjects;
