import { createBusNamespace } from '@makaio/core';
import { ModelRegistrySchemas } from './schemas.js';

/**
 * Model Registry namespace for accessing model information.
 *
 * Provides bus subjects for:
 * - Resolving a single model for a provider
 * - Listing all models for a lab or provider
 * - Refreshing registry from remote source
 * - Observing registry refresh commits
 *
 * Prefix: 'modelRegistry.'
 * @example
 * ```typescript
 * // Get all models for a provider
 * const result = await bus.request(ModelRegistrySubjects.getProviderModels, {
 *   providerId: 'anthropic',
 * });
 *
 * // Resolve a single model
 * const resolved = await bus.request(ModelRegistrySubjects.getForProvider, {
 *   providerId: 'anthropic',
 *   model: 'claude-sonnet-4-6',
 * });
 *
 * // Force refresh from remote
 * await bus.request(ModelRegistrySubjects.refresh, {});
 *
 * // Observe committed refreshes
 * bus.on(ModelRegistrySubjects.changed, () => {
 *   // Rescan dependent providers
 * });
 * ```
 */
export const ModelRegistryNamespace = createBusNamespace('modelRegistry', ModelRegistrySchemas);

/**
 * Pre-extracted subjects for direct import.
 * @example
 * ```typescript
 * import { ModelRegistrySubjects } from '@makaio/services-core/model-registry';
 *
 * bus.on(ModelRegistrySubjects.getProviderModels, (ctx) => {
 *   ctx.setResult({ models: resolveModels(ctx.payload.providerId) });
 * });
 * ```
 */
export const ModelRegistrySubjects = ModelRegistryNamespace.subjects;
