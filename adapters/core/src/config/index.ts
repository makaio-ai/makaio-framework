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
export { resolveProviderEndpoint, type ProviderEndpoint } from './resolve-provider-endpoint.js';

// Shared provider resolution helper (config + definition + endpoint + credentials in one call)
/** @public */
export { resolveProviderResolution, type ProviderResolution } from './resolve-provider-resolution.js';

// Connector-layer credential resolution (moved from services-core in Phase 2)
export { resolveConnectorCredentials } from './resolve-connector-credentials.js';
export { buildCredentialEnv } from './build-credential-env.js';

// Consolidated session environment helper for subprocess connectors
export {
  resolveSessionEnvironment,
  type SessionEnvironmentOptions,
  type SessionEnvironmentResult,
} from './resolve-session-environment.js';
