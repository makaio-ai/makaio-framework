/**
 * Adapter subsystem contracts.
 *
 * Exposes the canonical bus schemas, namespace subjects, and repository types
 * shared by the future adapter-subsystem service and framework consumers.
 * @packageDocumentation
 */

export {
  AdapterFileConfigSchema,
  AdapterReadinessSchema,
  AdapterSubsystemSchemas,
  BindingRecordSchema,
  EffectiveAdapterSchema,
  ProviderConfigFileRecordSchema,
} from './schemas.js';
export type {
  AdapterFileConfig,
  AdapterReadiness,
  BindingRecord,
  EffectiveAdapter,
  ProviderConfigFileRecord,
} from './schemas.js';
export type { AdapterFileConfigSet, IAdapterConfigRepository, ProviderConfigFileSet } from './types.js';
export {
  CanonicalProviderConfigCredentialRefsSchema,
  CanonicalProviderConfigPatchSchema,
  CreateCanonicalProviderConfigInputSchema,
} from './write-types.js';
export type {
  CanonicalProviderConfigCredentialRefs,
  CanonicalProviderConfigCredentialRefsPayload,
  CanonicalProviderConfigPatch,
  CreateCanonicalProviderConfigInput,
  CreateCanonicalProviderConfigInputPayload,
} from './write-types.js';
export { AdapterSubsystemNamespace, AdapterSubsystemSubjects } from './namespace.js';
