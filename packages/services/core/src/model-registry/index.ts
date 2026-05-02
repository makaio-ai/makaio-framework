/**
 * `@makaio/services-core/model-registry`
 *
 * Model registry service for discovering and caching AI model configurations.
 */
export {
  ModelRegistrySchema,
  ModelRegistrySchemas,
  ProviderModelOverrideSchema,
  type ModelRegistry,
  type ProviderModelOverride,
  type ModelRegistryGetForProviderRequest,
  type ModelRegistryGetForProviderResponse,
  type ModelRegistryGetLabModelsRequest,
  type ModelRegistryGetLabModelsResponse,
  type ModelRegistryGetProviderModelsRequest,
  type ModelRegistryGetProviderModelsResponse,
  type ModelRegistryRefreshRequest,
  type ModelRegistryRefreshResponse,
  type ModelRegistryCheckModelInProvidersRequest,
  type ModelRegistryCheckModelInProvidersResponse,
} from './schemas.js';
export { ModelRegistryNamespace, ModelRegistrySubjects } from './namespace.js';
export {
  ModelRegistryProviderNotFoundError,
  ModelRegistryService,
  type ModelRegistryServiceOptions,
} from './model-registry-service.js';
export { FallbackRegistryFetcher } from './fallback-registry-fetcher.js';
export { CachedRegistryFetcher } from './cached-registry-fetcher.js';
export type { IModelRegistryCache, IModelRegistryFetcher } from './types.js';
export { mergeModelMetadata } from './merge-utils.js';
