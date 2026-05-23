/**
 * Utility functions for mapping adapter session lineage to Makaio session branch kinds.
 */

import type { SessionLineageKind, SessionLineage, BranchKind } from '@makaio/contracts';

/**
 * Maps adapter-level session lineage kind to Makaio session branch kind.
 * Root sessions have no branch kind (undefined).
 * @param kind - The adapter session's lineage kind
 * @returns The corresponding BranchKind, or undefined for root sessions
 */
export function kindToBranchKind(kind: SessionLineageKind): BranchKind | undefined {
  switch (kind) {
    case 'fork':
      return 'fork';
    case 'subagent':
      return 'subagent';
    case 'compress':
      return 'compress';
    case 'root':
      return undefined;
    default: {
      const _exhaustive: never = kind;
      return undefined;
    }
  }
}

/**
 * Convert lineage metadata to a canonical `SessionLineage` discriminated union.
 * @param metadata - Object with kind, parentAdapterSessionId, and forkPointMessageId
 * @returns Canonical lineage object matching session contracts
 */
export function toSessionLineage(metadata: {
  kind: SessionLineageKind;
  parentAdapterSessionId: string | null;
  forkPointMessageId: string | null;
}): SessionLineage {
  switch (metadata.kind) {
    case 'root':
      return { kind: 'root', parentAdapterSessionId: null, forkPointMessageId: null };
    case 'fork':
      return {
        kind: 'fork',
        parentAdapterSessionId: metadata.parentAdapterSessionId!,
        forkPointMessageId: metadata.forkPointMessageId!,
      };
    case 'subagent':
      return {
        kind: 'subagent',
        parentAdapterSessionId: metadata.parentAdapterSessionId!,
        forkPointMessageId: null,
      };
    case 'compress':
      return {
        kind: 'compress',
        parentAdapterSessionId: metadata.parentAdapterSessionId!,
        forkPointMessageId: null,
      };
    default: {
      const _exhaustive: never = metadata.kind;
      return _exhaustive;
    }
  }
}
