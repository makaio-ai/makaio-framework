import { z } from 'zod';
import { createStorageNamespace } from '@makaio/storage-core';
import {
  AdapterSessionStatusSchema,
  CompressSessionLineageSchema,
  ForkSessionLineageSchema,
  RootSessionLineageSchema,
  SessionLineageKindSchema,
  SubagentSessionLineageSchema,
} from '@makaio/contracts';
import { adapterSessions } from './schema.js';

/**
 * Shared Zod schema for the adapter session response object.
 *
 * Used by `get`, `getByLogFilePath`, and `list` responses.
 */
export const AdapterSessionResponseSchema = z.object({
  adapterSessionId: z.string(),
  adapterName: z.string(),
  parentAdapterSessionId: z.string().nullable(),
  forkPointMessageId: z.string().nullable(),
  sessionId: z.string().nullable(),
  model: z.string().nullable(),
  cwd: z.string().nullable(),
  logFilePath: z.string().nullable(),
  discoveredAt: z.number(),
  startedAt: z.number(),
  status: AdapterSessionStatusSchema,
  /** Relationship to parent: root session, user fork, or subagent. */
  kind: SessionLineageKindSchema,
});

const AdapterSessionUpsertBaseSchema = z.object({
  adapterSessionId: z.string(),
  adapterName: z.string(),
  model: z.string().nullable(),
  cwd: z.string().nullable(),
  /** Absolute path to the source log file on disk. */
  logFilePath: z.string().nullable().optional(),
  /** Unix ms timestamp of when the session started. Optional; handler defaults to Date.now(). */
  startedAt: z.number().finite().optional(),
});

const AdapterSessionUpsertRequestSchema = z.discriminatedUnion('kind', [
  AdapterSessionUpsertBaseSchema.merge(RootSessionLineageSchema),
  AdapterSessionUpsertBaseSchema.merge(ForkSessionLineageSchema),
  AdapterSessionUpsertBaseSchema.merge(SubagentSessionLineageSchema),
  AdapterSessionUpsertBaseSchema.merge(CompressSessionLineageSchema),
]);

const CreateAndLinkRootMetadataSchema = RootSessionLineageSchema.omit({ kind: true }).extend({
  kind: z.null(),
});

const CreateAndLinkMetadataLineageSchema = z.union([
  CreateAndLinkRootMetadataSchema,
  ForkSessionLineageSchema,
  SubagentSessionLineageSchema,
  CompressSessionLineageSchema,
]);

export const CreateAndLinkMetadataSchema = CreateAndLinkMetadataLineageSchema.and(
  z.object({
    /** AI model name used in this session, if known. */
    model: z.string().nullable(),
    /** Working directory for scope resolution, if known. */
    cwd: z.string().nullable(),
    /** Human-readable session title, if known. */
    title: z.string().nullable(),
  }),
);

/**
 * Inferred type for an adapter session record.
 *
 * Represents the full adapter session record as returned by `get`, `list`,
 * and `getByLogFilePath` bus subjects.
 */
export type AdapterSessionRecord = z.infer<typeof AdapterSessionResponseSchema>;
export type AdapterSessionStatus = z.infer<typeof AdapterSessionStatusSchema>;
export type CreateAndLinkMetadata = z.infer<typeof CreateAndLinkMetadataSchema>;

/**
 * Adapter session storage namespace.
 *
 * Provides bus subjects for managing adapter session records.
 * Adapter sessions track sessions discovered from external adapter logs
 * (e.g., Claude Code) and maintain lineage information for fork detection.
 */
export const AdapterSessionStorageNamespace = createStorageNamespace('adapterSession', {
  schemas: {
    /**
     * Upsert an adapter session record.
     *
     * If the record exists, updates mutable fields (parent, forkPoint, model, cwd).
     * If not, inserts with discoveredAt=Date.now() and status='discovered'.
     *
     * Subject: `storage:adapterSession.upsert`
     * Type: Request (RPC)
     */
    upsert: {
      request: AdapterSessionUpsertRequestSchema,
      response: z.object({
        adapterSessionId: z.string(),
        sessionId: z.string().nullable(),
        created: z.boolean(),
      }),
    },

    /**
     * Get an adapter session by ID.
     *
     * Subject: `storage:adapterSession.get`
     * Type: Request (RPC)
     */
    get: {
      request: z.object({
        adapterSessionId: z.string(),
      }),
      response: z.object({
        session: AdapterSessionResponseSchema.nullable(),
      }),
    },

    /**
     * Update adapter session status.
     *
     * Subject: `storage:adapterSession.updateStatus`
     * Type: Request (RPC)
     */
    updateStatus: {
      request: z.object({
        adapterSessionId: z.string(),
        status: AdapterSessionStatusSchema,
      }),
      response: z.object({
        success: z.boolean(),
      }),
    },

    /**
     * Link an adapter session to a Makaio session.
     *
     * Subject: `storage:adapterSession.linkSession`
     * Type: Request (RPC)
     */
    linkSession: {
      request: z.object({
        adapterSessionId: z.string(),
        sessionId: z.string(),
      }),
      response: z.object({
        success: z.boolean(),
      }),
    },

    /**
     * Get an adapter session by its source log file path.
     *
     * Subject: `storage:adapterSession.getByLogFilePath`
     * Type: Request (RPC)
     */
    getByLogFilePath: {
      request: z.object({
        /** Absolute path to the source log file on disk. */
        logFilePath: z.string(),
      }),
      response: z.object({
        session: AdapterSessionResponseSchema.nullable(),
      }),
    },

    /**
     * List all adapter sessions.
     *
     * Returns all adapter session records ordered by startedAt descending.
     * Used by the entity cache to populate the reactive `adapterSessions` collection.
     *
     * Subject: `storage:adapterSession.list`
     * Type: Request (RPC)
     */
    list: {
      request: z.object({}),
      response: z.object({
        sessions: z.array(AdapterSessionResponseSchema),
      }),
    },

    /**
     * Count adapter sessions grouped by status.
     *
     * Subject: `storage:adapterSession.countByAdapter`
     * Type: Request (RPC)
     */
    countByAdapter: {
      request: z.object({
        adapterName: z.string(),
      }),
      response: z.object({
        /** Total sessions discovered for this adapter */
        total: z.number(),
        /** Sessions with status='imported' */
        imported: z.number(),
        /** Sessions with status='discovered' (pending import) */
        discovered: z.number(),
      }),
    },

    /**
     * Create and link a Makaio session for an adapter session.
     *
     * Consolidates session creation, parent/scope resolution, linking,
     * and event emission into a single idempotent bus request.
     * The bus field is injected by the handler — callers must not pass it.
     *
     * Subject: `storage:adapterSession.createAndLink`
     * Type: Request (RPC)
     */
    createAndLink: {
      request: z.object({
        /** Adapter-specific session identifier. */
        adapterSessionId: z.string(),
        /** Adapter type name (e.g., 'claude-code'). */
        adapterName: z.string(),
        /** Adapter instance ID (machine/installation specific). */
        adapterId: z.string(),
        /** Session metadata from the adapter. */
        metadata: CreateAndLinkMetadataSchema,
        /** Existing Makaio sessionId to reuse (e.g., from discovery stub). */
        existingSessionId: z.string().optional(),
      }),
      response: z.object({
        /** The Makaio session ID (either newly created or pre-existing). */
        sessionId: z.string(),
        /** Whether a new session record was created during this call. */
        created: z.boolean(),
      }),
    },
  },
  extensions: {
    drizzle: {
      adapterSessions,
    },
  },
});

/**
 * Typed subjects for adapter session storage operations.
 */
export const AdapterSessionStorageSubjects = AdapterSessionStorageNamespace.subjects;
