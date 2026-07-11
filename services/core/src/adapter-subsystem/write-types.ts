import { z } from 'zod';
import { ProviderConfigAuthSchema, ProviderConfigManagerSchema } from '@makaio/contracts/auth';
import { isCanonicalProviderConfigName } from '@makaio/contracts/config';
import { ModelFilterModeSchema, ModelVisibilitySchema, ProtocolEndpointsSchema } from '@makaio/contracts/provider';

const INVALID_PROVIDER_CONFIG_NAME_MESSAGE = 'Provider config name must slugify to a canonical routing segment.';

/**
 * Canonical create payload for provider configs.
 *
 * Authentication is structurally complete at creation time. Callers that need
 * to store plaintext first create a disabled config whose auth selection
 * already contains stored credential refs, then enable it after storage
 * succeeds.
 */
export const CreateCanonicalProviderConfigInputSchema = z
  .object({
    definitionId: z.string().trim().min(1),
    name: z.string().optional(),
    auth: ProviderConfigAuthSchema,
    managedBy: ProviderConfigManagerSchema.optional(),
    endpointOverrides: ProtocolEndpointsSchema.optional(),
    modelVisibility: z.record(z.string(), ModelVisibilitySchema).optional(),
    modelFilterMode: ModelFilterModeSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.auth.method.owner === 'provider' && input.auth.method.providerDefinitionId !== input.definitionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provider-owned auth methods must belong to the selected provider definition.',
        path: ['auth', 'method', 'providerDefinitionId'],
      });
    }
  })
  .refine((input) => input.name === undefined || isCanonicalProviderConfigName(input.name), {
    message: INVALID_PROVIDER_CONFIG_NAME_MESSAGE,
    path: ['name'],
  });

/**
 * Canonical patch payload for provider configs.
 *
 * Model-filter mode changes flow through `setModelFilterMode`; authentication
 * changes flow through `setProviderConfigAuth`. Lifecycle management is fixed
 * at creation and is not part of the generic patch seam.
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
 * Inferred canonical auth replacement (post-validation, with branded refs).
 */
export type CanonicalProviderConfigAuth = z.infer<typeof ProviderConfigAuthSchema>;

/**
 * Bus-layer auth replacement payload (pre-validation input type).
 *
 * Request handlers receive the schema input shape from the bus context, so
 * credential refs inside explicit selections arrive as plain strings until
 * the schema parse brands them.
 */
export type CanonicalProviderConfigAuthPayload = z.input<typeof ProviderConfigAuthSchema>;
