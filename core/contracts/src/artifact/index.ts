export {
  ArtifactActorSchema,
  ArtifactCompareRequestSchema,
  ArtifactCompareResponseSchema,
  ArtifactConflictPolicySchema,
  ArtifactKindRegistrationSchema,
  ArtifactObservationSchema,
  ArtifactQueryRequestSchema,
  ArtifactQueryScopeSchema,
  ArtifactRefSchema,
  ArtifactRelationQueryTargetSchema,
  ArtifactRelationSchema,
  ArtifactRelationTargetSchema,
  ArtifactRepresentationsSchema,
  ArtifactRevisionSchema,
  ArtifactScopeSchema,
  ConfidenceBasisSchema,
  ConfidenceLevelSchema,
  ConfidenceMetadataSchema,
  EvidenceRefSchema,
  LocalRefSchema,
  RelationTypeRegistrationSchema,
} from './schemas.js';
export type {
  ArtifactActor,
  ArtifactCompareRequest,
  ArtifactCompareResponse,
  ArtifactConflictPolicy,
  ArtifactKindRegistration,
  ArtifactObservation,
  ArtifactQueryRequest,
  ArtifactQueryScope,
  ArtifactRef,
  ArtifactRelation,
  ArtifactRelationQueryTarget,
  ArtifactRelationTarget,
  ArtifactRepresentations,
  ArtifactRevision,
  ArtifactScope,
  ConfidenceBasis,
  ConfidenceLevel,
  ConfidenceMetadata,
  EvidenceRef,
  LocalRef,
  RelationTypeRegistration,
} from './schemas.js';
export { defineArtifactKind } from './kind-definition.js';
export type {
  AnyArtifactKindDefinition,
  ArtifactDataOf,
  ArtifactKindDefinition,
  ArtifactOf,
} from './kind-definition.js';
export { defineArtifactLifecycleHooks } from './lifecycle-hooks.js';
export type {
  ArtifactDraft,
  ArtifactDraftPatch,
  ArtifactHookFilter,
  ArtifactLifecycleHookDefinition,
  ArtifactLifecycleHookEvent,
  ArtifactLifecycleHookRegistration,
  ArtifactLifecycleSemanticEvent,
  ArtifactReactionHookContext,
  ArtifactReactionHookRegistration,
  BeforeArtifactHookContext,
  BeforeArtifactHookRegistration,
} from './lifecycle-hooks.js';
export {
  ARTIFACT_CONTEXT_RENDER_HINTS,
  ArtifactContextRelationSelectorSchema,
  ArtifactContextRenderHintSchema,
  ArtifactContextSelectorSchema,
} from './context-selectors.js';
export type {
  ArtifactContextKnownRenderHint,
  ArtifactContextRelationSelector,
  ArtifactContextRenderHint,
  ArtifactContextSelector,
} from './context-selectors.js';
export {
  ArtifactContextRefEntrySchema,
  ArtifactContextUnresolvedReasonSchema,
  ResolvedArtifactContextWireSchema,
} from './context-resolution.js';
export type {
  ArtifactContextRefEntry,
  ArtifactContextUnresolvedReason,
  ResolvedArtifactContextWire,
} from './context-resolution.js';
export { hydrateArtifactContextTree } from './hydrate-context.js';
export type {
  ArtifactContextRootNode,
  ArtifactContextNode,
  ArtifactContextTree,
  ResolvedArtifactContextNode,
  UnresolvedArtifactContextNode,
} from './context-tree.js';
export { ArtifactNamespace, ArtifactSchemas, ArtifactSubjects } from './namespace.js';
export type {
  ArtifactCreatedPayload,
  ArtifactCreateRequest,
  ArtifactCreateResponse,
  ArtifactKindChangedPayload,
  ArtifactKindListRequest,
  ArtifactKindListResponse,
  ArtifactKindRegisterRequest,
  ArtifactKindRegisterResponse,
  ArtifactObservationAddedPayload,
  ArtifactQueryResponse,
  ArtifactRelationAddedPayload,
  ArtifactRelationTypeListRequest,
  ArtifactRelationTypeListResponse,
  ArtifactRelationTypeRegisterRequest,
  ArtifactRelationTypeRegisterResponse,
  ArtifactResolveContextRequest,
  ArtifactResolveContextResponse,
  ArtifactResolveRequest,
  ArtifactResolveResponse,
  ArtifactRevisedPayload,
  ArtifactReviseRequest,
  ArtifactReviseResponse,
  ArtifactStatusChangedPayload,
} from './namespace.js';
