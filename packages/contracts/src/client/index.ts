/**
 * Public API for the client contracts.
 *
 * Exports static client definitions, domain schemas (including observed
 * session semantics), the registered bus namespace, and the definition
 * factory helper.
 * @packageDocumentation
 */

export {
  ClientBinaryCompatibilitySchema,
  ClientDefinitionSchema,
  ClientHookEventDeclarationSchema,
  ClientRuntimeCapabilitiesSchema,
  ClientToolCapabilityAnnotationSchema,
  ClientToolDefinitionSchema,
  ConfigIsolationSchema,
  GithubReleaseInstallDescriptorSchema,
  LogSourceDefinitionSchema,
  ManagedInstallDescriptorSchema,
  ManifestBucketInstallDescriptorSchema,
  NpmInstallDescriptorSchema,
  PostInstallDescriptorSchema,
} from './definition.js';
export type {
  ClientBinaryCompatibility,
  ClientDefinition,
  ClientDefinitionInput,
  ClientHookEventDeclaration,
  ClientRuntimeCapabilities,
  ClientToolCapabilityAnnotation,
  ClientToolDefinition,
  ConfigIsolation,
  GithubReleaseInstallDescriptor,
  LogSourceDefinition,
  ManagedInstallDescriptor,
  ManifestBucketInstallDescriptor,
  NpmInstallDescriptor,
  PostInstallDescriptor,
} from './definition.js';
export { ClientExecutionContextSchema, ClientResolveBinarySchema, ClientSchemas } from './schemas.js';
export type { ClientExecutionContext, ClientResolveBinaryRequest, ClientResolveBinaryResponse } from './schemas.js';
export {
  ClientAccountIdentifierSchema,
  ClientAccountObserveSchema,
  ClientIdentifierStrengthSchema,
  ClientIdentityObservationSchema,
  ClientMetadataSchema,
  ClientScanResultSchema,
  ClientScanTargetSchema,
  ClientSessionAccountObserveSchema,
  ClientSessionLocatorSchema,
  ClientUsageIngestSchema,
  ClientUsageSnapshotSchema,
  ClientUsageWindowSchema,
  ClientUsageWindowsSchema,
} from './account-identity.js';
export type {
  ClientAccountIdentifier,
  ClientAccountObserveRequest,
  ClientAccountObserveResponse,
  ClientIdentifierStrength,
  ClientIdentityObservation,
  ClientScanResult,
  ClientScanTarget,
  ClientSessionAccountObserveRequest,
  ClientSessionAccountObserveResponse,
  ClientSessionLocator,
  ClientUsageIngestRequest,
  ClientUsageIngestResponse,
  ClientUsageSnapshot,
  ClientUsageWindow,
  ClientUsageWindows,
} from './account-identity.js';
export {
  ClientBinaryListEntrySchema,
  ClientInstallCompletedSchema,
  ClientInstallProgressSchema,
  ClientInstallSchema,
  ClientListSchema,
  ClientSetActiveSchema,
  ClientUninstallSchema,
  ClientUpdateSchema,
  ClientVersionChangedSchema,
  InstalledVersionEntrySchema,
  InstallErrorSchema,
  InstallStageSchema,
  LatestVersionSourceStatusSchema,
  ManagedInstallStrategySchema,
} from './binary-management.js';
export type {
  ClientBinaryListEntry,
  ClientInstallCompleted,
  ClientInstallProgress,
  ClientInstallRequest,
  ClientInstallResponse,
  ClientListRequest,
  ClientListResponse,
  ClientSetActiveRequest,
  ClientSetActiveResponse,
  ClientUninstallRequest,
  ClientUninstallResponse,
  ClientUpdateRequest,
  ClientUpdateResponse,
  ClientVersionChanged,
  InstalledVersionEntry,
  InstallError,
  InstallStage,
  LatestVersionSourceStatus,
  ManagedInstallStrategy,
} from './binary-management.js';
export {
  ClientRuntimeEvidenceBaseSchema,
  ClientRuntimeObserveSchema,
  ClientRuntimeSourceLayerSchema,
  ClientRuntimeSourceSchema,
  ClientRuntimeStartedSchema,
} from './runtime-observation.js';
export type {
  ClientRuntimeEvidenceBase,
  ClientRuntimeObserveRequest,
  ClientRuntimeObserveResponse,
  ClientRuntimeSource,
  ClientRuntimeSourceLayer,
  ClientRuntimeStarted,
} from './runtime-observation.js';
export {
  ClientSessionObservedBaseSchema,
  ClientSessionStartedSchema,
  ClientSessionToolPostSchema,
  ClientSessionToolPreSchema,
  ClientSessionTurnCompletedSchema,
  ClientSessionTurnStartedSchema,
  ClientSessionUserPromptSubmittedSchema,
  ClientWiringEntrySchema,
} from './session-observed.js';
export type {
  ClientSessionObservedBase,
  ClientSessionStarted,
  ClientSessionToolPost,
  ClientSessionToolPre,
  ClientSessionTurnCompleted,
  ClientSessionTurnStarted,
  ClientSessionUserPromptSubmitted,
  ClientWiringEntry,
} from './session-observed.js';
export { ClientNamespace, ClientSubjects } from './namespace.js';
export { createClientDefinition } from './create-definition.js';
