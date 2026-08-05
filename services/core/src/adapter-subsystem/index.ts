/**
 * Adapter subsystem contracts.
 *
 * Exposes the canonical bus schemas, namespace subjects, and repository types
 * shared by the future adapter-subsystem service and framework consumers.
 * @packageDocumentation
 */

export {
  AdapterFileConfigSchema,
  AdapterRuntimePackagesSchema,
  AdapterRuntimeSnapshotErrorCodeSchema,
  AdapterRuntimeSnapshotResolutionSchema,
  AdapterRuntimeSnapshotSchema,
  AdapterReadinessSchema,
  AdapterSubsystemSchemas,
  BindingRecordSchema,
  CompatibleAuthOptionSchema,
  EffectiveAdapterSchema,
  ProviderConfigAuthSummarySchema,
  ProviderConfigFileRecordSchema,
  ProviderRuntimeSnapshotSchema,
} from './schemas.js';
export type {
  AdapterFileConfig,
  AdapterRuntimePackages,
  AdapterRuntimeSnapshot,
  AdapterRuntimeSnapshotErrorCode,
  AdapterRuntimeSnapshotResolution,
  AdapterReadiness,
  BindingRecord,
  CompatibleAuthOption,
  EffectiveAdapter,
  ProviderConfigAuthSummary,
  ProviderConfigFileRecord,
  ProviderRuntimeSnapshot,
} from './schemas.js';
export type { AdapterFileConfigSet, IAdapterConfigRepository, ProviderConfigFileSet } from './types.js';
export { CanonicalProviderConfigPatchSchema, CreateCanonicalProviderConfigInputSchema } from './write-types.js';
export type {
  CanonicalProviderConfigAuth,
  CanonicalProviderConfigAuthPayload,
  CanonicalProviderConfigPatch,
  CreateCanonicalProviderConfigInput,
  CreateCanonicalProviderConfigInputPayload,
} from './write-types.js';
export { ADAPTER_SUBSYSTEM_PACKAGE_NAME, AdapterSubsystemNamespace, AdapterSubsystemSubjects } from './namespace.js';
