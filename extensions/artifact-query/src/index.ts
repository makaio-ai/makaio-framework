import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts/extension';
import { createArtifactQueryToolset } from './toolset.js';
import type { ArtifactReadHost } from './read-artifacts.js';

/**
 * Create the selected Artifact read extension, optionally bound to an authorized host.
 * @param host - Access policy supplied by the hosting application.
 * @returns An extension that contributes read tools only when a host is configured.
 */
export function createArtifactQueryPackage(host?: ArtifactReadHost): MakaioNodeExtension<IMakaioBus> {
  return {
    name: 'artifact-query',
    displayName: 'Artifact Query Tools',
    version: '0.1.0',
    surface: 'headless',
    tools: {
      createToolsets: () => (host ? [createArtifactQueryToolset(host)] : []),
    },
  };
}

/** Unbound package marker; hosts must explicitly contribute an authorized toolset. */
export const artifactQueryPackage = createArtifactQueryPackage();

export default artifactQueryPackage;

export { executeReadArtifacts } from './read-artifacts.js';
export type { ArtifactReadHost } from './read-artifacts.js';
export { ReadArtifactsInputSchema, ReadArtifactsOutputSchema } from './schemas.js';
export type { ReadArtifactsInput, ReadArtifactsOutput } from './schemas.js';
export { createReadArtifactsTool, createArtifactQueryToolset } from './toolset.js';
