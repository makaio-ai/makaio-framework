/**
 * Utility functions for mapping adapter session lineage to Makaio session branch kinds.
 */

import type { SessionLineageKind, BranchKind } from '@makaio/contracts';

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
