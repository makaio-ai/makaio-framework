import { z } from 'zod';
import { ProviderConfigAuthSchema, ProviderConfigManagerSchema } from '../auth/selection.js';
import { ModelFilterModeSchema, ModelVisibilitySchema } from '../provider/visibility.js';
import { StoredProtocolEndpointsSchema } from './provider-defaults.js';

/** Canonical schema version string for provider config files. */
export const PROVIDER_CONFIG_SCHEMA_VERSION = 'makaio/provider-config/v2' as const;

/**
 * Schema for `.makaio/provider-configs/<providerConfigId>.json`.
 *
 * The file stem is the canonical `providerConfigId`; the payload stores one
 * explicit authentication selection. Credential values remain ref-only and
 * plaintext secrets stay behind the credential-service boundary.
 */
export const ProviderConfigFileSchema = z
  .object({
    $schema: z.literal(PROVIDER_CONFIG_SCHEMA_VERSION),
    definitionId: z.string().trim().min(1),
    name: z.string().trim().min(1).optional(),
    auth: ProviderConfigAuthSchema,
    managedBy: ProviderConfigManagerSchema.optional(),
    endpointOverrides: StoredProtocolEndpointsSchema.optional(),
    modelFilterMode: ModelFilterModeSchema.optional(),
    modelVisibility: z.record(z.string(), ModelVisibilitySchema).optional(),
    isDefault: z.boolean().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((config, ctx) => {
    const { method } = config.auth;
    if (method.owner === 'provider' && method.providerDefinitionId !== config.definitionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provider-owned auth methods must belong to the containing provider definition.',
        path: ['auth', 'method', 'providerDefinitionId'],
      });
    }
    if (config.enabled === false && config.isDefault === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A disabled provider config cannot be the default.',
        path: ['isDefault'],
      });
    }
  });

/** Inferred type for a file-canonical provider config record. */
export type ProviderConfigFile = z.infer<typeof ProviderConfigFileSchema>;
