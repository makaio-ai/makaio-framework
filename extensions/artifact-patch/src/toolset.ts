import { ArtifactPatchRequestSchema, ArtifactPatchResponseSchema } from '@makaio/contracts';
import { defineTool, defineToolset, widenTool } from '@makaio/tools-core';
import { executePatchArtifact, type ArtifactPatchHost } from './patch-artifact.js';

/**
 * Create an authorized patch-based Artifact revision tool.
 *
 * The tool is a facade and nothing more: its input and output are the
 * `artifact.patch` request and response contracts unchanged, so an agent and a
 * bus client describe the same write in the same words.
 * @param host - Access policy supplied by the hosting application.
 * @returns A patch tool bound to the supplied host.
 */
export function createPatchArtifactTool(host: ArtifactPatchHost) {
  return defineTool({
    name: 'artifacts_patch',
    description:
      'Revise an Artifact by sending only the change. Name the artifact, the baseRevision you read, and the ' +
      'instructions: $set and $unset on declared paths, $push and $pull on declared collections. Address one ' +
      'collection entry by field match with $[name] plus arrayFilters, or by position. An unknown path, an ' +
      'unknown operator and addressing nothing are all errors, never silent no-ops. Use dryRun to check a patch ' +
      'without writing. A stale baseRevision reports the current revision; follow the repair field of that error: ' +
      'only an append at a fixed path (no position, no filter) may be resent with the new baseRevision, anything ' +
      'else needs a fresh read and a rewritten patch.',
    annotations: { readOnly: false, idempotent: false },
    inputSchema: ArtifactPatchRequestSchema,
    outputSchema: ArtifactPatchResponseSchema,
    execute: (input, context) => executePatchArtifact(input, context, host),
  });
}

/**
 * Create a toolset for patch-based Artifact revisions through one authorized host.
 * @param host - Access policy supplied by the hosting application.
 * @returns A toolset containing the host-bound patch tool.
 */
export function createArtifactPatchToolset(host: ArtifactPatchHost) {
  return defineToolset({
    name: 'artifact-patch',
    description: 'Revise Artifacts by patch through an authorized host.',
    version: '0.1.0',
    tools: [widenTool(createPatchArtifactTool(host))],
  });
}
