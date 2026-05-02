import { z } from 'zod';

export { AIModelSchema } from '@makaio/contracts';
export { BaseAdapterConfigSchema, ProviderConfigSchema, ProviderDefaultsSchema } from '@makaio/contracts/config';

/**
 * Base schema for adapter provider configuration.
 *
 * Adapters extend this schema to add provider-specific fields.
 * All fields use `.describe()` to provide UI hints for form generation.
 *
 * This schema is intentionally empty - it serves as a type marker.
 * Adapters define their own providerSettings fields.
 * @example
 * ```typescript
 * // In adapter definition:
 * const MyProviderSettingsSchema = BaseProviderSettingsSchema.extend({
 *   apiKey: z.string().describe('API key for authentication'),
 *   baseUrl: z.string().url().optional().describe('Custom API endpoint'),
 * });
 * ```
 */
export const BaseProviderConfigSchema = z.record(z.string(), z.unknown());
