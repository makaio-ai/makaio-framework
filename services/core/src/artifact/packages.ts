import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { extensionToken } from '@makaio/contracts';
import { ArtifactSchemaRegistry } from './artifact-schema-registry.js';

/** Token for the artifact schema registry service. */
export const ArtifactSchemaRegistryToken = extensionToken<ArtifactSchemaRegistry>('artifact-schema-registry');

/** Package that starts the framework artifact schema registry. */
export const artifactSchemaRegistryPackage: MakaioNodeExtension<IMakaioBus> = {
  name: ArtifactSchemaRegistryToken.name,
  displayName: 'Artifact Schema Registry',
  version: '0.1.0',
  critical: true,
  create: (ctx) => new ArtifactSchemaRegistry(ctx.bus),
};
