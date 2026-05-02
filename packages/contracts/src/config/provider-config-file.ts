import { z } from 'zod';
import { ModelFilterModeSchema, ModelVisibilitySchema } from '../provider/visibility.js';
import { CredentialRefSchema } from './credential-ref.js';
import { StoredProtocolEndpointsSchema } from './provider-defaults.js';

/**
 * Canonical schema version string for provider config files.
 */
export const PROVIDER_CONFIG_SCHEMA_VERSION = 'makaio/provider-config/v1' as const;

/**
 * Schema for `.makaio/provider-configs/<providerConfigId>.json`.
 *
 * The file stem is the canonical `providerConfigId`; the payload only stores
 * the entity fields that belong to the provider config itself. Credential
 * entries are ref-only; plaintext secrets must stay behind the credential
 * service boundary.
 */
export const ProviderConfigFileSchema = z
  .object({
    $schema: z.literal(PROVIDER_CONFIG_SCHEMA_VERSION),
    definitionId: z.string().trim().min(1),
    name: z.string().trim().min(1).optional(),
    credentials: z.record(z.string(), CredentialRefSchema).optional(),
    endpointOverrides: StoredProtocolEndpointsSchema.optional(),
    modelFilterMode: ModelFilterModeSchema.optional(),
    modelVisibility: z.record(z.string(), ModelVisibilitySchema).optional(),
    isDefault: z.boolean().optional(),
    enabled: z.boolean().optional(),
    isSentinel: z.boolean().optional(),
  })
  .strict();

/**
 * Inferred type for a file-canonical provider config record.
 */
export type ProviderConfigFile = z.infer<typeof ProviderConfigFileSchema>;
