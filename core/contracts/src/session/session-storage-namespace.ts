import { z } from 'zod';
import { createContractStorageNamespace } from '../storage-namespace-definition.js';
import { MakaioSessionSchema } from './schemas.js';
import { ApprovalPolicySchema } from '../harness/schemas.js';
import { BranchKindSchema, ImportStatusSchema, SessionContextInheritanceSchema } from './schemas/primitives.js';
import { ForkChildInfoSchema } from './schemas/fork-child-info.js';
import { SessionPreviewDataSchema, SessionRecordMetadataSchema, SessionWithPreviewSchema } from './schemas/session.js';
import { ClientIdentityObservationSchema } from '../client/account-identity.js';
import {
  RootSessionLineageSchema,
  ForkSessionLineageSchema,
  SubagentSessionLineageSchema,
  CompressSessionLineageSchema,
} from '../adapter/schemas/session-lineage.js';

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

/**
 * Shared Zod field for `machineId` on session storage write payloads.
 *
 * Stable runtime machine identity that owns the provider-native session store.
 * Caller-supplied by the owning hook/runtime. Storage handlers must never
 * derive this from the writer process because imports may be performed by
 * central or downstream servers.
 */
const MachineIdFieldSchema = z.string().nullable().optional();

/** Lifecycle status a stored session row can carry. */
const SessionStorageStatusSchema = z.enum(['active', 'closed', 'archived', 'discovered']);

const SessionStorageUpdateRequestPayloadSchema = z.object({
  sessionId: z.string(),
  status: SessionStorageStatusSchema.optional(),
  /**
   * Only apply this update when the stored status is one of these.
   *
   * Makes a status transition a compare-and-swap, which is what a caller acting
   * on an *observation* needs: it read a row, decided the observation implies a
   * transition, and by the time it writes, a concurrent archive or delete may
   * have made that decision wrong. Without the guard the write lands anyway and
   * silently undoes the newer state. Same shape and same reason as
   * `storage:agent.updateStatus`'s `expectedStatus`.
   *
   * Omitted, the update is unconditional — the existing behavior every current
   * caller relies on. Supplied, a refused write reports `success: false`, which
   * a caller distinguishes from a missing row by re-reading; storage will not
   * guess which of the two it was.
   */
  expectedStatus: z.array(SessionStorageStatusSchema).nonempty().optional(),
  parentSessionId: z.string().optional(),
  contextInheritance: SessionContextInheritanceSchema.optional(),
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
  /** Opaque consumer-owned JSON metadata. Null clears it; omission leaves it unchanged. */
  metadata: SessionRecordMetadataSchema.nullable().optional(),
  /**
   * Write-once spawn provenance. Non-null updates fill missing values without
   * overwriting an existing tool-call assignment; null explicitly clears it.
   */
  spawningToolCallId: z.string().nullable().optional(),
  /** {@inheritDoc MachineIdFieldSchema} */
  machineId: MachineIdFieldSchema,
  // The adapter-session currency pair is deliberately absent. Resume currency
  // has exactly one writer — the `storage:sessionOwnership` seam — because it
  // is the only surface that states who is allowed to write it: a claim
  // generation, checked in the same transaction as the write. A partial-update
  // surface has no notion of authority at all, so a caller holding a
  // pre-movement view could resurrect an abandoned provider session through
  // it, past every fence the ownership seam maintains.
  //
  // `leadAgentId` is absent for the same reason and one more: the designation
  // is a compare-and-swap the reserving transaction owns end to end (I11), and
  // an unconditional partial write is not one.
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

// ─── Import upsert schemas ──────────────────────────────────────────────────

const ImportUpsertActivationSchema = z.enum(['live']);

const ImportUpsertBaseSchema = z.object({
  /** External tool's session identifier (becomes adapterSessionId on the sessions row). */
  externalSessionId: z.string(),
  /** Source tool identity (e.g., 'claude-code', 'codex', 'opencode'). */
  source: z.string(),
  /** Optional link to a known client. */
  clientId: z.string().optional(),
  /** Adapter instance ID for resume resolution. */
  adapterId: z.string().optional(),
  /** Working directory. */
  cwd: z.string().nullable(),
  /** Absolute path to the source log file on disk. */
  logFilePath: z.string().nullable().optional(),
  /** Unix ms timestamp of when the session started in the external tool. */
  startedAt: z.number().finite().optional(),
  /** Session title if known from logs. */
  title: z.string().nullable().optional(),
  /**
   * Opaque, JSON-safe consumer-owned metadata attached at registration time.
   *
   * Merge contract (implemented by the storage handlers): on first insert the
   * value is stored as-is; on conflict/enrichment the stored value and the
   * incoming value are shallow-merged at the top-level key level with EXISTING
   * keys winning. Metadata supplied at hook-first registration is therefore
   * preserved — later import enrichment merges in new keys and never
   * overwrites existing ones.
   */
  metadata: SessionRecordMetadataSchema.optional(),
  /**
   * Initial client identity observation captured at hook-first registration.
   *
   * On enrichment, storage prefers a non-null incoming value over the stored
   * one so later observations can refine identity evidence.
   */
  lastClientIdentityObservation: ClientIdentityObservationSchema.optional(),
  /**
   * Creation-time import lifecycle status.
   *
   * - `'tracking'`: live-followed observed session (hook-first registration).
   * - `'discovered'`: watcher discovery (the default when omitted).
   *
   * On enrichment the stored importStatus is never downgraded — handlers keep
   * COALESCE(existing, incoming) semantics. `'imported'` is intentionally
   * excluded here: that transition is owned by `updateImportStatus`.
   */
  importStatus: z.enum(['discovered', 'tracking']).optional(),
  /**
   * Lifecycle activation intent for live external observations.
   *
   * `'live'` means the caller has observed an externally running session and
   * storage may create it as active or promote an existing discovered row to
   * active. Storage handlers must preserve closed and archived sessions.
   *
   * This is separate from importStatus and from log-import ingestion markers.
   */
  activation: ImportUpsertActivationSchema.optional(),
  /**
   * Whether the external tool marked this session as a sidechain/subagent
   * perspective (e.g. Claude Code's per-record `isSidechain` flag).
   *
   * Absent means unknown or a live session. On enrichment, storage prefers a
   * defined incoming value over the stored one.
   */
  isSidechain: z.boolean().optional(),
  /** {@inheritDoc MachineIdFieldSchema} */
  machineId: MachineIdFieldSchema,
});

export const ImportUpsertRequestSchema = z.discriminatedUnion('kind', [
  ImportUpsertBaseSchema.merge(RootSessionLineageSchema),
  ImportUpsertBaseSchema.merge(ForkSessionLineageSchema),
  ImportUpsertBaseSchema.merge(SubagentSessionLineageSchema),
  ImportUpsertBaseSchema.merge(CompressSessionLineageSchema),
]);

export type ImportUpsertRequest = z.infer<typeof ImportUpsertRequestSchema>;

// ─── Observed rebind schemas ────────────────────────────────────────────────

/**
 * Request payload for `storage:session.rebindObserved`.
 *
 * A rebind is the write a *continuation* of an already known external session
 * produces: the provider session keeps its identity, but the runtime observing
 * it may sit in a different working directory, on a different machine, or write
 * to a different transcript file. Only those runtime/locality facts are
 * refreshed. Origin identity (`source`, `adapterSessionId`), lineage,
 * `importStatus`, lifecycle `status`, `createdAt`, metadata and content are
 * deliberately out of reach — a continuation is not an import and must never
 * be able to rewrite what an import owns.
 *
 * Every locality field is optional and `undefined` means "unchanged": the
 * observing runtime reports what it knows, and absence of evidence must not
 * erase a stored value.
 */
export const SessionStorageRebindObservedRequestSchema = z.object({
  /** External tool's session identifier (matched against `adapterSessionId`). */
  externalSessionId: z.string(),
  /** Source tool identity — the second half of the import identity key. */
  source: z.string(),
  /** Working directory the continuation runs in. */
  cwd: z.string().optional(),
  /** Absolute path the continuation writes its transcript to. */
  logFilePath: z.string().optional(),
  /**
   * Stable runtime machine identity that owns the provider-native session store.
   *
   * Unlike the import upsert's fill-once merge, a rebind *overwrites*: the
   * machine running the continuation is the machine that now owns that store.
   * `null` relinquishes ownership, `undefined` leaves it unchanged.
   */
  machineId: MachineIdFieldSchema,
});

export type SessionStorageRebindObservedRequest = z.infer<typeof SessionStorageRebindObservedRequestSchema>;

/**
 * Result of `storage:session.rebindObserved`.
 *
 * `'not-found'` is a modeled outcome, not a failure and not an implicit
 * create: a continuation of a session storage has never seen carries no
 * trustworthy creation time, lineage or content, so storage reports the miss
 * and leaves session creation to the import path that does.
 */
export const SessionStorageRebindObservedResponseSchema = z.discriminatedUnion('outcome', [
  z.object({
    /** An existing row was rebound to the observing runtime. */
    outcome: z.literal('rebound'),
    /** Makaio session ID of the rebound row. */
    sessionId: z.string(),
  }),
  z.object({
    /** No row exists for the `(source, externalSessionId)` identity. */
    outcome: z.literal('not-found'),
  }),
]);

export type SessionStorageRebindObservedResult = z.infer<typeof SessionStorageRebindObservedResponseSchema>;

export { ImportStatusSchema, type ImportStatus } from './schemas/primitives.js';

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
export const SessionStorageNamespace = createContractStorageNamespace('session', {
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
     * Search sessions by message content (full-text: FTS5 on SQLite,
     * tsvector on Postgres) and session title (LIKE on both dialects).
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
        /**
         * Optional source adapter identity.
         *
         * When omitted, storage returns a session only if the external ID is
         * unique after all provided filters are applied. Supplying
         * `adapterName` narrows the ambiguity scope to that registered adapter;
         * otherwise ambiguous cross-source matches resolve to `null` instead
         * of picking an arbitrary row.
         */
        source: z.string().optional(),
        /**
         * Optional registered adapter identity.
         *
         * External registrations stamp `adapterName`, not import provenance
         * `source`, so callers that need the (`adapterName`, `adapterSessionId`)
         * idempotency key should use this filter.
         */
        adapterName: z.string().optional(),
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

    // ─── Import-related subjects ────────────────────────────────────────

    /**
     * Creates or updates an imported session record. On first import, creates a new
     * session with `status='discovered'` by default, or `status='active'` when live
     * activation is requested. On subsequent calls, enriches existing records with
     * COALESCE semantics so later scans can supply previously-unknown values without
     * overwriting already-populated ones.
     *
     * Subject: `storage:session.importUpsert`
     * Type: Request (RPC)
     */
    importUpsert: {
      request: ImportUpsertRequestSchema,
      response: z.object({
        /** Makaio session ID (newly created or existing). */
        sessionId: z.string(),
        /** Whether a new session record was created during this call. */
        created: z.boolean(),
      }),
    },

    /**
     * Rebind an already known observed session to the runtime that just
     * continued it (resume/compact).
     *
     * Refreshes runtime/locality columns only and reports a miss instead of
     * creating a row — see {@link SessionStorageRebindObservedRequestSchema}.
     *
     * Subject: `storage:session.rebindObserved`
     * Type: Request (RPC)
     */
    rebindObserved: {
      request: SessionStorageRebindObservedRequestSchema,
      response: SessionStorageRebindObservedResponseSchema,
    },

    /**
     * Get a session by its source log file path.
     * Used by the discovery orchestrator for cursor resumption.
     *
     * Subject: `storage:session.getByLogFilePath`
     * Type: Request (RPC)
     */
    getByLogFilePath: {
      request: z.object({
        logFilePath: z.string(),
      }),
      response: z.object({
        session: MakaioSessionSchema.nullable(),
      }),
    },

    /**
     * List imported sessions with optional source filter.
     *
     * Subject: `storage:session.listImported`
     * Type: Request (RPC)
     */
    listImported: {
      request: z.object({
        source: z.string().optional(),
        importStatus: ImportStatusSchema.optional(),
      }),
      response: z.object({
        sessions: z.array(MakaioSessionSchema),
      }),
    },

    /**
     * Count imported sessions grouped by importStatus for a given source.
     * Used by the UI dashboard to display import progress.
     *
     * Subject: `storage:session.countBySource`
     * Type: Request (RPC)
     */
    countBySource: {
      request: z.object({
        source: z.string(),
      }),
      response: z.object({
        total: z.number(),
        imported: z.number(),
        discovered: z.number(),
        tracking: z.number(),
      }),
    },

    /**
     * Update the import-specific status of a session.
     * Emits a lifecycle event on successful transition for entity cache reactivity.
     *
     * Subject: `storage:session.updateImportStatus`
     * Type: Request (RPC)
     */
    updateImportStatus: {
      request: z.object({
        sessionId: z.string(),
        importStatus: ImportStatusSchema,
      }),
      response: z.object({
        success: z.boolean(),
      }),
    },
  },
});

/**
 * Typed subjects for session storage bus operations.
 */
export const SessionStorageSubjects = SessionStorageNamespace.subjects;
