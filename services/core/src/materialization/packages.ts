import type { IMakaioBus } from '@makaio/bus-core';
import type { MakaioNodeExtension } from '@makaio/contracts';
import { dep, extensionToken } from '@makaio/contracts';
import { ArtifactSchemaRegistryToken } from '../artifact/packages.js';
import { ArtifactViewBuilderRegistry } from './artifact-view-builder-registry.js';
import { ArtifactViewService } from './artifact-view-service.js';
import { SurfaceBindingRegistry } from './surface-binding-registry.js';
import { MaterializationOperationCoordinator } from './materialization-operation-coordinator.js';

/** Token for the surface binding registry service. */
export const SurfaceBindingRegistryToken = extensionToken<SurfaceBindingRegistry>('surface-binding-registry');
/** Token for the artifact view builder registry service. */
export const ArtifactViewBuilderRegistryToken = extensionToken<ArtifactViewBuilderRegistry>(
  'artifact-view-builder-registry',
);
/** Token for the artifact view resolver service. */
export const ArtifactViewServiceToken = extensionToken<ArtifactViewService>('artifact-view-service');
/** Token for the materialization operation coordinator service. */
export const MaterializationOperationCoordinatorToken = extensionToken<MaterializationOperationCoordinator>(
  'materialization-operation-coordinator',
);

/** Package that coordinates artifact and provider-object materialization leases. */
export const materializationOperationCoordinatorPackage: MakaioNodeExtension<IMakaioBus> = {
  name: MaterializationOperationCoordinatorToken.name,
  displayName: 'Materialization Operation Coordinator',
  version: '0.1.0',
  critical: true,
  create: () => new MaterializationOperationCoordinator(),
};

/** Package that starts the framework surface binding registry. */
export const surfaceBindingRegistryPackage: MakaioNodeExtension<IMakaioBus> = {
  name: SurfaceBindingRegistryToken.name,
  displayName: 'Surface Binding Registry',
  version: '0.1.0',
  critical: true,
  create: (ctx) => new SurfaceBindingRegistry(ctx.bus),
};

/**
 * Package that starts the framework artifact view builder registry.
 *
 * The registry is a pure in-process data structure with no bus handlers.
 * It implements the extension service lifecycle directly: no `init` work is
 * needed and `destroy()` clears all registrations.
 */
export const artifactViewBuilderRegistryPackage: MakaioNodeExtension<IMakaioBus> = {
  name: ArtifactViewBuilderRegistryToken.name,
  displayName: 'Artifact View Builder Registry',
  version: '0.1.0',
  critical: true,
  create: () => new ArtifactViewBuilderRegistry(),
};

/**
 * Package that starts the framework artifact view resolver service.
 *
 * Registers the `materialization.artifact.view.resolve` bus handler and
 * orchestrates the affordance truth table, generic builder, custom builder
 * dispatch, and Zod output validation. Depends on the artifact schema
 * registry (for kind lookups) and the builder registry (for custom
 * builder dispatch).
 */
export const artifactViewServicePackage: MakaioNodeExtension<IMakaioBus> = {
  name: ArtifactViewServiceToken.name,
  displayName: 'Artifact View Service',
  version: '0.1.0',
  critical: true,
  dependencies: [dep(ArtifactSchemaRegistryToken.name), dep(ArtifactViewBuilderRegistryToken.name)],
  create: (ctx) => {
    const schemaRegistry = ctx.getService(ArtifactSchemaRegistryToken);
    const builderRegistry = ctx.getService(ArtifactViewBuilderRegistryToken);
    if (schemaRegistry === undefined) {
      throw new Error('ArtifactSchemaRegistry is not available for ArtifactViewService');
    }
    if (builderRegistry === undefined) {
      throw new Error('ArtifactViewBuilderRegistry is not available for ArtifactViewService');
    }
    return new ArtifactViewService(ctx.bus, schemaRegistry, builderRegistry);
  },
};
