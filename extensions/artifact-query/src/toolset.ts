import { defineTool, defineToolset, widenTool } from '@makaio/tools-core';
import { executeReadArtifacts, type ArtifactReadHost } from './read-artifacts.js';
import { ReadArtifactsInputSchema, ReadArtifactsOutputSchema } from './schemas.js';

/**
 * Create an authorized selected-Artifact read tool.
 * @param host - Access policy supplied by the hosting application.
 * @returns A read tool bound to the supplied host.
 */
export function createReadArtifactsTool(host: ArtifactReadHost) {
  return defineTool({
    name: 'artifacts_read',
    description:
      'Read selected Artifact content. State a short purpose, then request one or more artifact references by kind and ID. ' +
      'Use the default compact view, a named view, explicit data-relative fields, or full for the complete original data.',
    annotations: { readOnly: true },
    inputSchema: ReadArtifactsInputSchema,
    outputSchema: ReadArtifactsOutputSchema,
    execute: (input, context) => executeReadArtifacts(input, context, host),
  });
}

/**
 * Create a toolset for selected Artifact reads through one authorized host.
 * @param host - Access policy supplied by the hosting application.
 * @returns A toolset containing the host-bound read tool.
 */
export function createArtifactQueryToolset(host: ArtifactReadHost) {
  return defineToolset({
    name: 'artifact-query',
    description: 'Read selected Artifact content through an authorized host.',
    version: '0.1.0',
    tools: [widenTool(createReadArtifactsTool(host))],
  });
}
