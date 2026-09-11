import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts/extension';
import { createArtifactPatchToolset } from './toolset.js';
import type { ArtifactPatchHost } from './patch-artifact.js';

/**
 * Create the patch-based Artifact revision extension, optionally bound to an authorized host.
 * @param host - Access policy supplied by the hosting application.
 * @returns An extension that contributes the patch tool only when a host is configured.
 */
export function createArtifactPatchPackage(host?: ArtifactPatchHost): MakaioNodeExtension<IMakaioBus> {
  return {
    name: 'artifact-patch',
    displayName: 'Artifact Patch Tools',
    version: '0.1.0',
    surface: 'headless',
    tools: {
      createToolsets: () => (host ? [createArtifactPatchToolset(host)] : []),
    },
  };
}

/** Unbound package marker; hosts must explicitly contribute an authorized toolset. */
export const artifactPatchPackage = createArtifactPatchPackage();

export default artifactPatchPackage;

export { applyArtifactPatch } from './patch-engine.js';
export type { ArtifactPatchApplication, ArtifactPatchApplicationResult } from './patch-engine.js';
export { executePatchArtifact, patchArtifact } from './patch-artifact.js';
export type {
  ArtifactPatchHost,
  ArtifactPatchStoreConflict,
  ArtifactPatchStoreRequest,
  ArtifactPatchStoreResult,
} from './patch-artifact.js';
export { createArtifactPatchToolset, createPatchArtifactTool } from './toolset.js';
