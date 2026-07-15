export {
  ArtifactViewBuilderCollisionError,
  ArtifactViewBuilderRegistry,
} from './artifact-view-builder-registry.js';
export { createArtifactViewBuilderContributionProcessor } from './artifact-view-builder-contribution-processor.js';
export { ArtifactViewService, isAffordancePermitted } from './artifact-view-service.js';
export { SurfaceBindingRegistry } from './surface-binding-registry.js';
export { createSurfaceBindingContributionProcessor } from './surface-binding-contribution-processor.js';
export { buildGenericArtifactView, GENERIC_ARTIFACT_VIEW_BUILDER_VERSION } from './generic-artifact-view-builder.js';
export {
  MaterializationOperationCoordinator,
  type MaterializationOperationLease,
  type MaterializationOperationRequestOrigin,
  type MaterializationOperationScope,
  type MaterializationProviderObject,
} from './materialization-operation-coordinator.js';
// The `@makaio/services-core/materialization` subpath owns the full
// materialization export surface, including the extension packages and DI
// tokens defined in the materialization-owned packages module.
export {
  artifactViewBuilderRegistryPackage,
  ArtifactViewBuilderRegistryToken,
  artifactViewServicePackage,
  ArtifactViewServiceToken,
  materializationOperationCoordinatorPackage,
  MaterializationOperationCoordinatorToken,
  surfaceBindingRegistryPackage,
  SurfaceBindingRegistryToken,
} from './packages.js';
