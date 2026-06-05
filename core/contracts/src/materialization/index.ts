export {
  ArtifactMaterializationRefSchema,
  ArtifactProjectionPolicySchema,
  SurfaceBindingRegistrationSchema,
  SurfaceBindingTargetSchema,
} from './schemas.js';
export type {
  ArtifactMaterializationRef,
  ArtifactProjectionPolicy,
  SurfaceBindingRegistration,
  SurfaceBindingTarget,
} from './schemas.js';
export { defineSurfaceBinding } from './definition.js';
export type { SurfaceBindingDefinition } from './definition.js';
export { MaterializationNamespace, MaterializationSchemas, MaterializationSubjects } from './namespace.js';
export type {
  MaterializationCapabilityResolvedPayload,
  MaterializationRefChangedPayload,
  SurfaceBindingChangedPayload,
  SurfaceBindingListRequest,
  SurfaceBindingListResponse,
  SurfaceBindingRegisterRequest,
  SurfaceBindingRegisterResponse,
} from './namespace.js';
