import { z } from 'zod';

const RESERVED_AUTH_FIELD_IDS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Portable identifier used as an own-property key in authentication field maps.
 *
 * Prototype-mutating property names are rejected even when a specific consumer
 * currently constructs null-prototype records. Keeping the restriction in the
 * contract prevents a later plain-object consumer from changing field meaning.
 */
export const AuthFieldIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, {
    message: 'Expected a portable authentication field identifier.',
  })
  .refine((fieldId) => !RESERVED_AUTH_FIELD_IDS.has(fieldId), {
    message: 'Authentication field identifiers must not use reserved object property names.',
  });

/**
 * Environment variable name accepted by authentication declarations.
 *
 * The contract intentionally models portable process-environment identifiers,
 * not shell expressions or assignments.
 */
export const AuthEnvironmentVariableNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, {
  message: 'Expected a valid environment variable name (letters, digits, and underscores).',
});

/** Environment-variable source hint for an explicit credential field. */
export const AuthCredentialSourceHintSchema = z
  .object({
    kind: z.literal('environment'),
    variable: AuthEnvironmentVariableNameSchema,
  })
  .strict();

/** Static declaration of one credential field required by an auth method. */
export const AuthCredentialFieldDefinitionSchema = z
  .object({
    id: AuthFieldIdSchema,
    label: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    required: z.boolean(),
    secret: z.boolean(),
    sourceHints: z.array(AuthCredentialSourceHintSchema),
  })
  .strict();

/**
 * Report duplicate identifiers at the duplicate declaration.
 * @param values - ID-bearing declarations to validate.
 * @param ctx - Zod refinement context used to report duplicate IDs.
 * @param label - Human-readable declaration kind for the validation message.
 */
function reportDuplicateIds(
  values: readonly { id: string }[],
  ctx: z.RefinementCtx,
  label: 'auth method' | 'credential field',
): void {
  const seenIds = new Set<string>();

  for (const [index, value] of values.entries()) {
    if (seenIds.has(value.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Duplicate ${label} ID "${value.id}".`,
        path: [index, 'id'],
      });
    } else {
      seenIds.add(value.id);
    }
  }
}

const ExplicitAuthCredentialFieldsSchema = z.array(AuthCredentialFieldDefinitionSchema).superRefine((fields, ctx) => {
  reportDuplicateIds(fields, ctx, 'credential field');

  if (!fields.some((field) => field.required)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'An explicit auth method must declare at least one required credential field.',
    });
  }
});

/** Authentication method whose credential values must be resolved explicitly. */
export const ExplicitAuthMethodDefinitionSchema = z
  .object({
    id: z.string().trim().min(1),
    mode: z.literal('explicit'),
    label: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    fields: ExplicitAuthCredentialFieldsSchema,
  })
  .strict();

/** Authentication method backed by a native client's persisted auth state. */
export const InferredAuthMethodDefinitionSchema = z
  .object({
    id: z.string().trim().min(1),
    mode: z.literal('inferred'),
    label: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
  })
  .strict();

/** Explicit declaration that a provider/client path requires no authentication. */
export const NoAuthMethodDefinitionSchema = z
  .object({
    id: z.string().trim().min(1),
    mode: z.literal('none'),
    label: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
  })
  .strict();

/** Provider-owned auth methods are explicit or deliberately unauthenticated. */
export const ProviderAuthMethodDefinitionSchema = z.discriminatedUnion('mode', [
  ExplicitAuthMethodDefinitionSchema,
  NoAuthMethodDefinitionSchema,
]);

/** Client-owned auth methods may additionally use native inferred auth. */
export const ClientAuthMethodDefinitionSchema = z.discriminatedUnion('mode', [
  ExplicitAuthMethodDefinitionSchema,
  InferredAuthMethodDefinitionSchema,
  NoAuthMethodDefinitionSchema,
]);

/** Unique provider-owned auth method declarations. */
export const ProviderAuthMethodsSchema = z
  .array(ProviderAuthMethodDefinitionSchema)
  .superRefine((methods, ctx) => reportDuplicateIds(methods, ctx, 'auth method'));

/** Unique client-owned auth method declarations. */
export const ClientAuthMethodsSchema = z
  .array(ClientAuthMethodDefinitionSchema)
  .superRefine((methods, ctx) => reportDuplicateIds(methods, ctx, 'auth method'));

/** Default native-auth selection declared by a client definition. */
export const ClientDefaultAuthSchema = z
  .object({
    providerDefinitionId: z.string().trim().min(1),
    methodId: z.string().trim().min(1),
  })
  .strict();

export type AuthEnvironmentVariableName = z.infer<typeof AuthEnvironmentVariableNameSchema>;
export type AuthFieldId = z.infer<typeof AuthFieldIdSchema>;
export type AuthCredentialSourceHint = z.infer<typeof AuthCredentialSourceHintSchema>;
export type AuthCredentialFieldDefinition = z.infer<typeof AuthCredentialFieldDefinitionSchema>;
export type ExplicitAuthMethodDefinition = z.infer<typeof ExplicitAuthMethodDefinitionSchema>;
export type InferredAuthMethodDefinition = z.infer<typeof InferredAuthMethodDefinitionSchema>;
export type NoAuthMethodDefinition = z.infer<typeof NoAuthMethodDefinitionSchema>;
export type ProviderAuthMethodDefinition = z.infer<typeof ProviderAuthMethodDefinitionSchema>;
export type ClientAuthMethodDefinition = z.infer<typeof ClientAuthMethodDefinitionSchema>;
export type ClientDefaultAuth = z.infer<typeof ClientDefaultAuthSchema>;
