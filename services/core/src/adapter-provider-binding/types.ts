import { z } from 'zod';

/**
 * Schema for an adapter-provider binding record as stored and returned from storage.
 *
 * Represents a link between an adapter and a ProviderConfig, with a default flag
 * indicating whether this is the preferred provider for the adapter.
 */
export const AdapterProviderBindingRecordSchema = z.object({
  /** UUID primary key */
  id: z.string(),
  /** Stable adapter name (e.g., 'claude-code') */
  adapterName: z.string(),
  /** FK to provider_configs.id */
  providerConfigId: z.string(),
  /** Whether this provider is the default for the adapter */
  isDefault: z.boolean(),
  /** Unix milliseconds timestamp when record was created */
  createdAt: z.number(),
  /** Unix milliseconds timestamp when record was last updated */
  updatedAt: z.number(),
});

/**
 * Schema for creating or updating an adapter-provider binding at the storage tier.
 *
 * Omits server-managed timestamps; these are set by the storage handler.
 */
export const AdapterProviderBindingInputSchema = z.object({
  /** UUID primary key */
  id: z.string(),
  /** Stable adapter name (e.g., 'claude-code') */
  adapterName: z.string(),
  /** FK to provider_configs.id */
  providerConfigId: z.string(),
  /** Whether this provider is the default for the adapter */
  isDefault: z.boolean(),
});

export type AdapterProviderBindingRecord = z.infer<typeof AdapterProviderBindingRecordSchema>;
export type AdapterProviderBindingInput = z.infer<typeof AdapterProviderBindingInputSchema>;
