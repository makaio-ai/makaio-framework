export { resolveCredentialRef, type ResolveCredentialRefDeps } from './resolve-credential-ref.js';
/** @public */
export { getDefinitionOrThrow } from './preset.js';

// Zod schemas
/** @public */
export { BaseProviderConfigSchema, BaseAdapterConfigSchema, ProviderConfigSchema, AIModelSchema } from './schemas.js';
export { ProviderDefaultsSchema } from './schemas.js';

// Inferred types (TimeoutConfig comes from @makaio/utils via ../timeout/index.js)
export type { BaseProviderConfig, BaseAdapterConfig, ProviderConfig, ProviderDefaults, AIModel } from './types.js';

// Config factory
export {
  createAdapterConfigFactory,
  type AdapterDefaults,
  type CreateAdapterConfigFactoryOptions,
  type AdapterConfigFactoryInput,
  type ConfigFactoryResult,
  type FactoryGuaranteedFields,
} from './factory.js';

// Provider endpoint resolution (for non-agent consumers like bridges)
export {
  resolveProviderEndpoint,
  ProviderEndpointAuthError,
  type ProviderEndpoint,
  type ProviderEndpointAuthRequirement,
  type ProviderEndpointAuthErrorCode,
} from './resolve-provider-endpoint.js';

// Shared refs-only provider resolution helper
/** @public */
export {
  resolveProviderResolution,
  ProviderResolutionError,
  type ProviderResolution,
  type ProviderResolutionErrorCode,
} from './resolve-provider-resolution.js';

// Connector-layer credential resolution (moved from services-core in Phase 2)
export {
  resolveConnectorCredentials,
  ConnectorCredentialResolutionError,
  type ConnectorCredentialResolutionErrorCode,
} from './resolve-connector-credentials.js';

// Consolidated session environment helper for subprocess connectors
export {
  resolveSessionEnvironment,
  type SessionEnvironmentOptions,
  type SessionEnvironmentResult,
} from './resolve-session-environment.js';

// Normalized adapter authentication compiler and connector-local resolver
export {
  bindProviderAuth,
  getOptionalAuthCredentialFields,
  resolveBoundProviderAuth,
  AdapterAuthError,
  type AdapterAuthErrorReason,
  type BindProviderAuthOptions,
  type BoundProviderAuthContext,
  type ResolveAuthCredentialRefs,
  type ResolvedAuthCredentialValues,
  type ResolvedAdapterAuth,
  type ResolvedConnectorAuthDelivery,
} from './resolve-adapter-auth.js';

// Central normalized auth materialization and explicit lease ownership
export {
  applySuppliedAdapterAuthRuntime,
  prepareAdapterAuthRuntime,
  type AdapterAuthLeaseHandle,
  type AdapterAuthRuntimePreparer,
  type BoundAdapterRuntimeConfig,
  type PreparedAdapterAuthRuntime,
  type ResolvedAdapterRuntimeConfig,
  type SuppliedAdapterAuthRuntime,
} from './adapter-auth-runtime.js';

// Atomic loaded-adapter/provider metadata read and refs-only binding
export {
  resolveAdapterRuntimeSnapshot,
  AdapterRuntimeSnapshotError,
  type AdapterRuntimeSnapshotErrorCode,
  type BoundAdapterRuntimeSnapshot,
} from './resolve-adapter-runtime-snapshot.js';
