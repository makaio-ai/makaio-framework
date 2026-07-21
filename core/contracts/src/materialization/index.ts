export {
  ArtifactMaterializationRefSchema,
  ArtifactProjectionPolicySchema,
  ProjectedFieldSchema,
  ProjectedFieldSemanticSchema,
  ProjectedFieldViewRoleSchema,
  SurfaceBindingRegistrationSchema,
  SurfaceBindingTargetSchema,
} from './schemas.js';
export type {
  ArtifactMaterializationRef,
  ArtifactProjectionPolicy,
  ProjectedField,
  ProjectedFieldSemantic,
  ProjectedFieldViewRole,
  SurfaceBindingRegistration,
  SurfaceBindingTarget,
} from './schemas.js';
export { defineSurfaceBinding } from './definition.js';
export type { SurfaceBindingDefinition } from './definition.js';
export {
  ArtifactViewResolveRequestSchema,
  ArtifactViewResolveResponseSchema,
  MaterializationNamespace,
  MaterializationSchemas,
  MaterializationSubjects,
} from './namespace.js';
export type {
  ArtifactViewResolveRequest,
  ArtifactViewResolveResponse,
  MaterializationCapabilityResolvedPayload,
  MaterializationRefChangedPayload,
  SurfaceBindingChangedPayload,
  SurfaceBindingListRequest,
  SurfaceBindingListResponse,
  SurfaceBindingRegisterRequest,
  SurfaceBindingRegisterResponse,
} from './namespace.js';
export {
  ArtifactViewCodeSectionSchema,
  ArtifactViewDiagramSectionSchema,
  ArtifactViewEvidenceSectionSchema,
  ArtifactViewLevelSchema,
  ArtifactViewLinkSchema,
  ArtifactViewIdentitySchema,
  ArtifactViewModelSchema,
  ArtifactViewNavigationSchema,
  ArtifactViewPropertiesSectionSchema,
  ArtifactViewRawSectionSchema,
  ArtifactViewRelationsSectionSchema,
  ArtifactViewSectionSchema,
  ArtifactViewSummarySectionSchema,
  ArtifactViewTableSectionSchema,
  ArtifactViewSurfaceLinksSchema,
} from './view-model.js';
export type {
  ArtifactViewCodeSection,
  ArtifactViewDiagramSection,
  ArtifactViewEvidenceSection,
  ArtifactViewLevel,
  ArtifactViewLink,
  ArtifactViewIdentity,
  ArtifactViewModel,
  ArtifactViewNavigation,
  ArtifactViewPropertiesSection,
  ArtifactViewRawSection,
  ArtifactViewRelationsSection,
  ArtifactViewSection,
  ArtifactViewSummarySection,
  ArtifactViewTableSection,
  ArtifactViewSurfaceLinks,
} from './view-model.js';
export {
  ArtifactViewAffordanceDeclarationSchema,
  ArtifactViewAffordanceRequestSchema,
  ArtifactViewParamsSchema,
  ArtifactViewRequestSchema,
  defineArtifactViewBuilder,
} from './view-builder.js';
export type {
  ArtifactViewAffordanceDeclaration,
  ArtifactViewAffordanceRequest,
  ArtifactViewBuilder,
  ArtifactViewBuilderContext,
  ArtifactViewBuilderResult,
  ArtifactViewParamsFor,
  ArtifactViewParamsMap,
  ArtifactViewRequest,
  ExtensionArtifactViewBuildersContribution,
} from './view-builder.js';
