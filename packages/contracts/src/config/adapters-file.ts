import { z } from 'zod';
import { CredentialRefSchema } from './credential-ref.js';
import { ModelFilterModeSchema, ModelVisibilitySchema } from '../provider/visibility.js';

/**
 * Configuration for a single provider entry inside `adapters.json`.
 */
export const AdaptersFileProviderSchema = z.object({
  name: z.string().optional(),
  providerId: z.string().optional(),
  credentials: z.record(z.string(), CredentialRefSchema).optional(),
  baseUrl: z.string().url().optional(),
  isDefault: z.boolean().optional(),
  enabled: z.boolean().optional(),
  modelFilterMode: ModelFilterModeSchema.optional(),
  modelVisibility: z.record(z.string(), ModelVisibilitySchema).optional(),
});

/**
 * Configuration for one adapter entry inside `adapters.json`.
 */
export const AdaptersFileAdapterSchema = z.object({
  providers: z.record(z.string(), AdaptersFileProviderSchema),
});

/**
 * Framework-owned file-based adapter configuration stored at `~/.makaio/adapters.json`.
 */
export const AdaptersFileSchema = z.object({
  $schema: z.literal('makaio/adapters-config/v1'),
  adapters: z.record(z.string(), AdaptersFileAdapterSchema),
});

export type AdaptersFile = z.infer<typeof AdaptersFileSchema>;
export type AdaptersFileAdapter = z.infer<typeof AdaptersFileAdapterSchema>;
export type AdaptersFileProvider = z.infer<typeof AdaptersFileProviderSchema>;
