import { z } from 'zod';
import {
  COMPRESS_SESSION_LINEAGE_KIND,
  FORK_SESSION_LINEAGE_KIND,
  ROOT_SESSION_LINEAGE_KIND,
  SUBAGENT_SESSION_LINEAGE_KIND,
} from '@makaio/contracts';
import { toSessionLineage } from '@makaio/services-core/session';
import type { ImportSegment, NormalizedEvent } from '@makaio/ai-adapters-core';

/**
 * Return a one-property object when a storage enrichment value is defined.
 * @param key - Property name to include.
 * @param value - Value to include when defined.
 * @returns Object containing the property, or an empty object.
 */
function definedProperty<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value !== undefined ? ({ [key]: value } as Record<K, V>) : {};
}

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
 * Build an import-upsert payload for `storage:session.importUpsert`.
 * @param metadata - Parsed session metadata from discovery/import.
 * @param source - Source tool identity (e.g., 'claude-code', 'codex').
 * @param cwd - Working directory metadata (nullable).
 * @param logFilePath - Source log path. Pass `undefined` to omit (no-op for log path),
 *   `null` to explicitly store as NULL (compress children that share the parent file),
 *   or a string for the parent session's absolute file path.
 * @param startedAt - Unix ms timestamp of when the session started in the external tool.
 *   Pass `undefined` to omit; the storage handler defaults to `Date.now()`.
 * @param adapterId - Optional adapter instance ID for cursor resume resolution.
 * @param clientId - Optional client identity link.
 * @param isSidechain - Optional sidechain flag from the segment's own log records
 *   (e.g. a subagent transcript). Pass `undefined` to leave the stored flag untouched.
 * @returns Strictly typed request payload for `storage:session.importUpsert`.
 */
export function toImportUpsertPayload(
  metadata: SessionMetadataFromEvent,
  source: string,
  cwd: string | null,
  logFilePath?: string | null,
  startedAt?: number,
  adapterId?: string,
  clientId?: string,
  isSidechain?: boolean,
) {
  const lineage = toSessionLineage(metadata);
  return {
    externalSessionId: metadata.adapterSessionId,
    source,
    cwd,
    ...definedProperty('logFilePath', logFilePath),
    ...definedProperty('startedAt', startedAt),
    ...definedProperty('adapterId', adapterId),
    ...definedProperty('clientId', clientId),
    ...definedProperty('isSidechain', isSidechain),
    ...lineage,
  };
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
