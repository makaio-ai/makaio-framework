import type { IMakaioBus } from '@makaio/bus-core';
import { ArtifactSubjects, type WorkflowArtifactBinding } from '@makaio/contracts';
import type { MakaioDatabase } from '@makaio/storage-drizzle';
import { getWorklogFrameEntryRow } from './worklog-storage.js';

interface ArtifactUpdatedRef {
  kind: string;
  id: string;
}

export interface ResolvedArtifactWriteMetadata {
  nodeId: string;
  artifact: WorkflowArtifactBinding;
}

/**
 * Resolve the WorkLog metadata that is intentionally not duplicated on the
 * `workflow.artifact.updated` event.
 * @param bus - Message bus used to resolve the artifact revision.
 * @param db - Drizzle database instance used to look up the frame row.
 * @param frameId - Frame that emitted the artifact write event.
 * @param artifactRef - Artifact reference from the event payload.
 * @param revision - Artifact revision identifier from the event payload.
 * @returns Node and artifact metadata, or `null` when the lookup cannot be completed.
 */
export async function resolveArtifactWriteMetadata(
  bus: IMakaioBus,
  db: MakaioDatabase,
  frameId: string,
  artifactRef: ArtifactUpdatedRef,
  revision: string | undefined,
): Promise<ResolvedArtifactWriteMetadata | null> {
  const frame = await getWorklogFrameEntryRow(db, frameId);
  if (frame === null || revision === undefined) {
    return null;
  }

  const resolved = await bus
    .requestOptional(ArtifactSubjects.resolve, {
      ref: {
        refClass: 'artifact',
        kind: artifactRef.kind,
        id: artifactRef.id,
        revision,
      },
    })
    .catch(() => undefined);

  if (resolved === undefined || !resolved.handled || resolved.data.artifact === null) {
    return null;
  }

  const { kind, schemaVersion, scope } = resolved.data.artifact;
  return {
    nodeId: frame.nodeId,
    artifact: { kind, schemaVersion, scope },
  };
}
