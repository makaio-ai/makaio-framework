/**
 * Public API for \@makaio/clients-core.
 * @packageDocumentation
 */

export { atomicModifyFile } from './atomic-modify-file.js';
export type { AtomicContentParser, AtomicModifier, AtomicModifyOutcome } from './atomic-modify-file.js';
export { BinaryNotFoundError } from './client-binary-errors.js';
export { ClientAccountRegistry } from './client-account-registry.js';
export type { ClientAccountUpsertResult } from './client-account-registry.js';
export { ClientBinaryManager } from './client-binary-manager.js';
export { isPathWithinBase, resolveAndValidateBasePath } from './client-binary-manager-types.js';
export type {
  ClientBinaryManagerConfig,
  ClientDefinitionLookup,
  InstallJob,
  JobCompletedCallback,
  JobCompletionCallback,
  JobCompletionResult,
  JobProgressCallback,
  PostInstallContext,
  PostInstallHandler,
} from './client-binary-manager-types.js';
export { ClientBinaryJobRunner } from './client-binary-job-runner.js';
export type { StrategyDependencies } from './binary-strategies/index.js';
export { ClientDefinitionRegistry } from './client-definition-registry.js';
export { ClientBinaryVersionResolver } from './client-binary-version-resolver.js';
export type { ResolvedInstallVersion } from './client-binary-version-resolver.js';
export { ClientRuntimeRegistry } from './client-runtime-registry.js';
export { CLIENT_RUNTIME_STATUSES } from './client-runtime-registry-types.js';
export type { ClientRuntimeRecord, ClientRuntimeStatus, RuntimeUpsertResult } from './client-runtime-registry-types.js';
export { ClientRuntimeService } from './client-runtime-service.js';
export { ClientConfigPrimeService } from './client-config-prime-service.js';
export { ClientProfileService } from './client-profile-service.js';
export { ClientSessionConfigService } from './client-session-config-service.js';
export {
  buildClientSessionBase,
  canonicalizeClientId,
  ClientSubjects,
  createRawClientHookReceivedSubject,
  emitBestEffort,
  pickNonEmptyString,
  pickNonEmptyStringValue,
  RawClientHookPayloadSchema,
} from './client-session-observed-semantics.js';
export type {
  BuildClientSessionBaseOpts,
  RawClientHookPayload,
  RawClientHookReceivedSubject,
} from './client-session-observed-semantics.js';
export { createClientNamespace } from './create-client-namespace.js';
export type { ClientNamespaceResult } from './create-client-namespace.js';
export { createClientWiringListSubjectDef, createClientWiringSubjectDef } from './create-client-wiring-list-subject.js';
export type { ClientWiringListSubjectDef, ClientWiringSubjectDefBase } from './create-client-wiring-list-subject.js';
export {
  ClientsCoreService,
  ClientsCoreToken,
  createClientsCorePackage,
  registerStorageHandlersWithRollback,
} from './package.js';
export type { ClientsCorePackageOptions } from './package.js';
export {
  ClientBinaryStateRecordSchema,
  ClientBinaryStorageNamespace,
  ClientBinaryStorageSubjects,
  ClientBinaryVersionRecordSchema,
} from './storage/client-binary-storage-namespace.js';
export type { ClientBinaryStateRecord, ClientBinaryVersionRecord } from './storage/client-binary-storage-namespace.js';
export {
  ClientRuntimeStorageNamespace,
  ClientRuntimeStorageSubjects,
  RuntimeRecordSchema,
} from './storage/runtime-storage-namespace.js';
export {
  ClientProfileStorageNamespace,
  ClientProfileStorageSubjects,
  ClientProfileRecordSchema,
} from './storage/profile-storage-namespace.js';
export type { ClientProfileRecord } from './storage/profile-storage-namespace.js';
export { resolveClientBinary } from './resolve-client-binary.js';
export { buildClientCommand, buildHookCommand, deriveSessionEventDescriptors } from './wiring-helpers.js';
export type { SessionEventDescriptor } from './wiring-helpers.js';
export {
  AbsolutePathSchema,
  assertAbsoluteProjectDir,
  ClientWiringAggregatedResultSchema,
  ClientWiringApplyResponseSchema,
  ClientWiringEntrySchema,
  ClientWiringListResponseSchema,
  ClientWiringRemoveResponseSchema,
} from './wiring-schemas.js';
export type {
  ClientWiringAggregatedResult,
  ClientWiringApplyResponse,
  ClientWiringEntry,
  ClientWiringListResponse,
  ClientWiringRemoveResponse,
} from './wiring-schemas.js';
