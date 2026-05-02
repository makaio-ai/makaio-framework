import { z } from 'zod';
import { CredentialRefSchema, isCanonicalProviderConfigName } from '@makaio/contracts/config';
import { ModelFilterModeSchema, ModelVisibilitySchema, ProtocolEndpointsSchema } from '@makaio/contracts/provider';

const INVALID_PROVIDER_CONFIG_NAME_MESSAGE = 'Provider config name must slugify to a canonical routing segment.';

/**
 * Canonical credential-ref map stored in provider-config files.
 */
export const CanonicalProviderConfigCredentialRefsSchema = z.record(z.string(), CredentialRefSchema);

/**
 * Canonical create payload for provider configs.
 *
 * Canonical subsystem writes are ref-only at rest. Public callers must resolve
 * any plaintext credentials before using this contract.
 */
export const CreateCanonicalProviderConfigInputSchema = z
  .object({
    definitionId: z.string(),
    name: z.string().optional(),
    credentialRefs: z.record(z.string(), CredentialRefSchema).optional(),
    endpointOverrides: ProtocolEndpointsSchema.optional(),
    modelVisibility: z.record(z.string(), ModelVisibilitySchema).optional(),
    modelFilterMode: ModelFilterModeSchema.optional(),
    isSentinel: z.boolean().optional(),
  })
  .strict()
  .refine((input) => input.name === undefined || isCanonicalProviderConfigName(input.name), {
    message: INVALID_PROVIDER_CONFIG_NAME_MESSAGE,
    path: ['name'],
  });

/**
 * Canonical patch payload for provider configs.
 *
 * Mode changes flow through `setModelFilterMode`. Sentinel state is not part of
 * the generic patch seam.
 */
export const CanonicalProviderConfigPatchSchema = z
  .object({
    name: z.string().optional(),
    endpointOverrides: ProtocolEndpointsSchema.nullable().optional(),
    modelVisibility: z.record(z.string(), ModelVisibilitySchema).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((input) => input.name === undefined || isCanonicalProviderConfigName(input.name), {
    message: INVALID_PROVIDER_CONFIG_NAME_MESSAGE,
    path: ['name'],
  });

/**
 * Inferred canonical create payload (post-validation, with branded credential refs).
 */
export type CreateCanonicalProviderConfigInput = z.infer<typeof CreateCanonicalProviderConfigInputSchema>;

/**
 * Bus-layer create payload (pre-validation input type, with unbranded credential refs).
 *
 * The bus infrastructure uses `z.input` for request payloads so callers can pass
 * plain strings that the schema validates and brands. Service handlers receive
 * this type from the bus context; only the Zod parse step produces the fully
 * branded {@link CreateCanonicalProviderConfigInput}.
 */
export type CreateCanonicalProviderConfigInputPayload = z.input<typeof CreateCanonicalProviderConfigInputSchema>;

/**
 * Inferred canonical patch payload.
 */
export type CanonicalProviderConfigPatch = z.infer<typeof CanonicalProviderConfigPatchSchema>;

/**
 * Inferred canonical credential-ref map (post-validation, with branded refs).
 */
export type CanonicalProviderConfigCredentialRefs = z.infer<typeof CanonicalProviderConfigCredentialRefsSchema>;

/**
 * Bus-layer credential-ref map payload (pre-validation input type).
 *
 * Request handlers receive the schema input shape from the bus context, so
 * credential refs arrive as plain strings until the schema parse brands them.
 */
export type CanonicalProviderConfigCredentialRefsPayload = z.input<typeof CanonicalProviderConfigCredentialRefsSchema>;
