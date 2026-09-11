export {
  ArtifactActorSchema,
  ArtifactCompareRequestSchema,
  ArtifactCompareResponseSchema,
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
  ArtifactStatusPathSchema,
  ConfidenceBasisSchema,
  ConfidenceLevelSchema,
  ConfidenceMetadataSchema,
  EvidenceRefSchema,
  EntityRefSchema,
  LocalRefSchema,
  RelationTypeRegistrationSchema,
} from './schemas.js';
export { ARTIFACT_VALUE_TYPE_KEYWORD, EVIDENCE_VALUE_TYPE, EvidenceValueSchema } from './evidence.js';
export type {
  ArtifactActor,
  ArtifactCompareRequest,
  ArtifactCompareResponse,
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
  EntityRef,
  LocalRef,
  RelationTypeRegistration,
} from './schemas.js';
export type { EvidenceValue } from './evidence.js';
export { EvidenceResolveRequestSchema, EvidenceResolveResponseSchema } from './evidence-resolution.js';
export type { EvidenceResolveRequest, EvidenceResolveResponse } from './evidence-resolution.js';
export { extractEvidenceOccurrences } from './evidence-occurrences.js';
export type { EvidenceOccurrence, EvidenceOccurrenceExtractionOptions } from './evidence-occurrences.js';
export { defineArtifactKind } from './kind-definition.js';
export type {
  AnyArtifactKindDefinition,
  ArtifactDataOf,
  ArtifactKindDefinition,
  ArtifactOf,
} from './kind-definition.js';
export { compileArtifactDataChecker, compileArtifactDataSchema } from './data-schema-validator.js';
export type {
  ArtifactDataCheck,
  ArtifactDataChecker,
  ArtifactDataIssue,
  ArtifactDataValidator,
} from './data-schema-validator.js';
export { defineArtifactLifecycleHooks } from './lifecycle-hooks.js';
export type {
  AfterArtifactHookContext,
  AfterArtifactHookRegistration,
  ArtifactDraft,
  ArtifactDraftPatch,
  ArtifactHookFilter,
  ArtifactLifecycleHookDefinition,
  ArtifactLifecycleHookEvent,
  ArtifactLifecycleHookRegistration,
  ArtifactLifecycleSemanticEvent,
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
  ArtifactEvidenceResolveRequest,
  ArtifactEvidenceResolveResponse,
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
  ArtifactPatchSubjectRequest,
  ArtifactPatchSubjectResponse,
  ArtifactResolveRequest,
  ArtifactResolveResponse,
  ArtifactRevisedPayload,
  ArtifactReviseRequest,
  ArtifactReviseResponse,
  ArtifactStatusChangedPayload,
} from './namespace.js';

export {
  ARTIFACT_CATEGORY_LIFECYCLE_STATES,
  ArtifactSchemaVersionSchema,
  ArtifactCategorySchema,
  ArtifactDataPathSchema,
  ArtifactLifecycleStateSchema,
  ArtifactRelationRequirementSchema,
  ArtifactUniquenessSelectorSchema,
  ArtifactUniquenessRuleSchema,
  ArtifactEvidenceRequirementsSchema,
  ArtifactKindViewSchema,
  ArtifactKindRegistrationSchema,
} from './kind-registration.js';
export type {
  ArtifactCategory,
  ArtifactLifecycleState,
  ArtifactRelationRequirement,
  ArtifactUniquenessRule,
  ArtifactEvidenceRequirements,
  ArtifactKindView,
  ArtifactKindRegistration,
} from './kind-registration.js';
export {
  ARTIFACT_COLLECTION_ELEMENT_SEGMENT,
  inspectArtifactDataLocation,
  isArtifactDataPathDeclared,
  readArtifactTitle,
} from './kind-paths.js';
export type { ArtifactSchemaFragment } from './kind-paths.js';

export {
  ARTIFACT_PATCH_ERROR_CODES,
  ARTIFACT_PATCH_OPERATORS,
  ArtifactPatchArrayFilterSchema,
  ArtifactPatchDocumentSchema,
  ArtifactPatchDryRunSchema,
  ArtifactPatchErrorSchema,
  ArtifactPatchFailureSchema,
  ArtifactPatchIssueSchema,
  ArtifactPatchMigrationSchema,
  ArtifactPatchOperationResultSchema,
  ArtifactPatchPathSchema,
  ArtifactPatchPersistedSchema,
  ArtifactPatchRequestSchema,
  ArtifactPatchResponseSchema,
  ArtifactPatchSuccessSchema,
  ArtifactPatchTargetSchema,
  artifactPatchFilterName,
  artifactPatchInstructions,
  artifactPatchPathFilterNames,
  artifactPatchSegment,
  artifactPatchSegments,
} from './patch.js';
export type {
  ArtifactPatchArrayFilter,
  ArtifactPatchDocument,
  ArtifactPatchError,
  ArtifactPatchErrorCode,
  ArtifactPatchInstruction,
  ArtifactPatchIssue,
  ArtifactPatchMigration,
  ArtifactPatchOperationResult,
  ArtifactPatchOperator,
  ArtifactPatchRequest,
  ArtifactPatchResponse,
  ArtifactPatchSegment,
  ArtifactPatchSuccess,
  ArtifactPatchTarget,
} from './patch.js';

export {
  ARTIFACT_LIFECYCLE_REJECTED_CODE,
  ArtifactLifecycleIdentitySchema,
  ArtifactLifecycleVersionSchema,
  ArtifactLifecycleSnapshotSchema,
  ArtifactLifecycleCurrentSchema,
  ArtifactLifecycleSituationSchema,
  ArtifactLifecycleTransitionIntentSchema,
  ArtifactLifecycleTransitionCommandSchema,
  ArtifactLifecycleInitializedEntrySchema,
  ArtifactLifecycleTransitionedEntrySchema,
  ArtifactLifecycleHistoryEntrySchema,
  ArtifactLifecycleRejectionSchema,
  ArtifactLifecycleError,
  initialArtifactLifecycle,
  advanceArtifactLifecycle,
  isArtifactLifecycleTransitionAllowed,
} from './lifecycle.js';
export type {
  ArtifactLifecycleSnapshot,
  ArtifactLifecycleCurrent,
  ArtifactLifecycleSituation,
  ArtifactLifecycleTransitionIntent,
  ArtifactLifecycleTransitionCommand,
  ArtifactLifecycleInitializedEntry,
  ArtifactLifecycleTransitionedEntry,
  ArtifactLifecycleHistoryEntry,
  ArtifactLifecycleRejection,
} from './lifecycle.js';

export {
  ArtifactLifecycleGetRequestSchema,
  ArtifactLifecycleGetResponseSchema,
  ArtifactLifecycleHistoryRequestSchema,
  ArtifactLifecycleHistoryResponseSchema,
  ArtifactLifecycleTransitionResponseSchema,
  ArtifactLifecycleCommittedPayloadSchema,
  ArtifactLifecycleFailureSchema,
  ArtifactLifecycleRejectedPayloadSchema,
  ArtifactLifecycleSchemas,
  toArtifactLifecycleFailure,
} from './lifecycle-namespace.js';
export type {
  ArtifactLifecycleGetRequest,
  ArtifactLifecycleGetResponse,
  ArtifactLifecycleHistoryRequest,
  ArtifactLifecycleHistoryResponse,
  ArtifactLifecycleTransitionResponse,
  ArtifactLifecycleCommittedPayload,
  ArtifactLifecycleFailure,
  ArtifactLifecycleRejectedPayload,
} from './lifecycle-namespace.js';
