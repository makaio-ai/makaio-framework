import { z } from 'zod';
import {
  COMPRESS_SESSION_LINEAGE_KIND,
  FORK_SESSION_LINEAGE_KIND,
  ROOT_SESSION_LINEAGE_KIND,
  SUBAGENT_SESSION_LINEAGE_KIND,
  type SessionLineage,
} from '@makaio/contracts';
import type { ImportSegment, NormalizedEvent } from '@makaio/ai-adapters-core';

const MetadataFromPayload = z.discriminatedUnion('kind', [
  z.object({
    adapterSessionId: z.string(),
    kind: z.literal(ROOT_SESSION_LINEAGE_KIND),
    parentAdapterSessionId: z.null().default(null),
    forkPointMessageId: z.null().default(null),
    model: z.string().nullable().default(null),
    cwd: z.string().nullable().default(null),
    startedAt: z.number().finite().optional(),
  }),
  z.object({
    adapterSessionId: z.string(),
    kind: z.literal(FORK_SESSION_LINEAGE_KIND),
    parentAdapterSessionId: z.string(),
    forkPointMessageId: z.string(),
    model: z.string().nullable().default(null),
    cwd: z.string().nullable().default(null),
    startedAt: z.number().finite().optional(),
  }),
  z.object({
    adapterSessionId: z.string(),
    kind: z.literal(SUBAGENT_SESSION_LINEAGE_KIND),
    parentAdapterSessionId: z.string(),
    forkPointMessageId: z.null().default(null),
    model: z.string().nullable().default(null),
    cwd: z.string().nullable().default(null),
    startedAt: z.number().finite().optional(),
  }),
  z.object({
    adapterSessionId: z.string(),
    kind: z.literal(COMPRESS_SESSION_LINEAGE_KIND),
    parentAdapterSessionId: z.string(),
    forkPointMessageId: z.null().default(null),
    model: z.string().nullable().default(null),
    cwd: z.string().nullable().default(null),
    startedAt: z.number().finite().optional(),
  }),
]);

type CreateAndLinkMetadataPayload =
  | {
      model: string | null;
      cwd: string | null;
      title: null;
      parentAdapterSessionId: string;
      forkPointMessageId: string;
      kind: 'fork';
    }
  | {
      model: string | null;
      cwd: string | null;
      title: null;
      parentAdapterSessionId: string;
      forkPointMessageId: null;
      kind: 'subagent';
    }
  | {
      model: string | null;
      cwd: string | null;
      title: null;
      parentAdapterSessionId: null;
      forkPointMessageId: null;
      kind: null;
    }
  | {
      model: string | null;
      cwd: string | null;
      title: null;
      parentAdapterSessionId: string;
      forkPointMessageId: null;
      kind: 'compress';
    };

/** Session metadata extracted from a discovery event payload. */
export type SessionMetadataFromEvent = z.infer<typeof MetadataFromPayload>;

/**
 * Extract session metadata from a session discovered event.
 * @param sessionEvent - The normalized session discovered event.
 * @returns Parsed lineage + metadata payload.
 */
export function extractSessionMetadata(sessionEvent: NormalizedEvent): SessionMetadataFromEvent {
  return MetadataFromPayload.parse(sessionEvent.payload);
}

/**
 * Build an adapter-session upsert payload with lineage invariants.
 * @param metadata - Parsed session metadata from discovery/import.
 * @param adapterName - Adapter name used for storage ownership.
 * @param model - Model metadata (nullable).
 * @param cwd - Working directory metadata (nullable).
 * @param logFilePath - Source log path. Pass `undefined` to omit (no-op upsert),
 *   `null` to explicitly store as NULL (compress children that share the parent file),
 *   or a string for the parent session's absolute file path.
 * @param startedAt - Unix ms timestamp of when the session started in the external tool.
 *   Pass `undefined` to omit; the storage handler defaults to `Date.now()`.
 * @returns Strictly typed request payload for `storage:adapterSession.upsert`.
 */
export function toAdapterSessionUpsertPayload(
  metadata: SessionMetadataFromEvent,
  adapterName: string,
  model: string | null,
  cwd: string | null,
  logFilePath?: string | null,
  startedAt?: number,
) {
  const lineage = toEnsureSessionLineage(metadata);
  return {
    adapterSessionId: metadata.adapterSessionId,
    adapterName,
    model,
    cwd,
    ...(logFilePath !== undefined ? { logFilePath } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...lineage,
  };
}

/**
 * Build the canonical create-and-link metadata payload from extracted session metadata.
 * @param metadata - Session metadata extracted from discovery/import records.
 * @returns Normalized payload for `AdapterSessionStorageSubjects.createAndLink`.
 */
export function toCreateAndLinkMetadata(metadata: SessionMetadataFromEvent): CreateAndLinkMetadataPayload {
  const base = {
    model: metadata.model,
    cwd: metadata.cwd,
    title: null,
  };

  switch (metadata.kind) {
    case 'fork':
      return {
        ...base,
        parentAdapterSessionId: metadata.parentAdapterSessionId,
        forkPointMessageId: metadata.forkPointMessageId,
        kind: metadata.kind,
      };
    case 'subagent':
      return {
        ...base,
        parentAdapterSessionId: metadata.parentAdapterSessionId,
        forkPointMessageId: null,
        kind: metadata.kind,
      };
    case 'root':
      return {
        ...base,
        parentAdapterSessionId: null,
        forkPointMessageId: null,
        kind: null,
      };
    case 'compress':
      return {
        ...base,
        parentAdapterSessionId: metadata.parentAdapterSessionId,
        forkPointMessageId: null,
        kind: metadata.kind,
      };
    default: {
      const _exhaustive: never = metadata;
      return _exhaustive;
    }
  }
}

/**
 * Convert metadata to canonical session lineage.
 * @param metadata - Parsed metadata to convert.
 * @returns Canonical lineage object matching session contracts.
 */
export function toEnsureSessionLineage(metadata: SessionMetadataFromEvent): SessionLineage {
  switch (metadata.kind) {
    case 'root':
      return { kind: 'root', parentAdapterSessionId: null, forkPointMessageId: null };
    case 'fork':
      return {
        kind: 'fork',
        parentAdapterSessionId: metadata.parentAdapterSessionId,
        forkPointMessageId: metadata.forkPointMessageId,
      };
    case 'subagent':
      return {
        kind: 'subagent',
        parentAdapterSessionId: metadata.parentAdapterSessionId,
        forkPointMessageId: null,
      };
    case 'compress':
      return {
        kind: 'compress',
        parentAdapterSessionId: metadata.parentAdapterSessionId,
        forkPointMessageId: null,
      };
    default: {
      const _exhaustive: never = metadata;
      return _exhaustive;
    }
  }
}

/**
 * Convert a canonical import segment into session metadata for persistence helpers.
 *
 * The direct-import path persists the explicit segment tree produced by the
 * importer. This helper keeps the lineage-to-storage bridge in one place so
 * the segment-tree path and event-derived path cannot drift.
 * @param segment - Canonical import segment with explicit lineage metadata
 * @param model - Model metadata inherited from the adapter context
 * @param cwd - Working directory metadata inherited from the adapter context
 * @returns Session metadata matching the existing create-and-link helpers
 */
export function toSessionMetadataFromImportSegment(
  segment: ImportSegment,
  model: string | null,
  cwd: string | null,
): SessionMetadataFromEvent {
  const base = {
    adapterSessionId: segment.adapterSessionId,
    model,
    cwd,
  };

  switch (segment.lineage.kind) {
    case 'root':
      return { ...base, kind: 'root', parentAdapterSessionId: null, forkPointMessageId: null };
    case 'fork':
      if (segment.lineage.parentAdapterSessionId == null) {
        throw new Error(`Fork segment ${segment.adapterSessionId} missing parentAdapterSessionId`);
      }
      if (segment.lineage.forkPointMessageId == null) {
        throw new Error(`Fork segment ${segment.adapterSessionId} missing forkPointMessageId`);
      }
      return {
        ...base,
        kind: 'fork',
        parentAdapterSessionId: segment.lineage.parentAdapterSessionId,
        forkPointMessageId: segment.lineage.forkPointMessageId,
      };
    case 'subagent':
      if (segment.lineage.parentAdapterSessionId == null) {
        throw new Error(`Subagent segment ${segment.adapterSessionId} missing parentAdapterSessionId`);
      }
      return {
        ...base,
        kind: 'subagent',
        parentAdapterSessionId: segment.lineage.parentAdapterSessionId,
        forkPointMessageId: null,
      };
    case 'compress':
      if (segment.lineage.parentAdapterSessionId == null) {
        throw new Error(`Compress segment ${segment.adapterSessionId} missing parentAdapterSessionId`);
      }
      return {
        ...base,
        kind: 'compress',
        parentAdapterSessionId: segment.lineage.parentAdapterSessionId,
        forkPointMessageId: null,
      };
    default: {
      const _exhaustive: never = segment.lineage.kind;
      throw new Error(`Unknown lineage kind: ${String(_exhaustive)}`);
    }
  }
}
