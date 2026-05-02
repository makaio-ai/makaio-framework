import type { z } from 'zod';
import type {
  BaseProviderConfigSchema,
  ProviderConfigSchema,
  ProviderDefaultsSchema,
  BaseAdapterConfigSchema,
  AIModelSchema,
} from './schemas.js';

/**
 * Base provider configuration type.
 * Adapters extend this for their provider-specific fields.
 */
export type BaseProviderConfig = z.infer<typeof BaseProviderConfigSchema>;

/**
 * AI model information type.
 */
export type AIModel = z.infer<typeof AIModelSchema>;

/**
 * Provider defaults configuration type.
 */
export type ProviderDefaults = z.infer<typeof ProviderDefaultsSchema>;

/**
 * Configuration for a single adapter provider.
 */
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/**
 * Adapter configuration file structure.
 * Stored at `~/.makaio/adapters/<adapterName>/config.json`.
 */
export type BaseAdapterConfig = z.infer<typeof BaseAdapterConfigSchema>;
