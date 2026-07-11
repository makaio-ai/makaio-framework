import { z } from 'zod';
import { CredentialRefSchema } from '../config/credential-ref.js';
import { AuthFieldIdSchema } from './definitions.js';

/**
 * Credential reference accepted by normalized authentication selections.
 *
 * Account identity is carried separately through
 * {@link NativeAccountSelectionSchema}; credential refs identify only
 * resolvable secret sources.
 */
export const AuthCredentialRefSchema = CredentialRefSchema;

/** Reference to an authentication method owned by a provider definition. */
export const ProviderAuthMethodRefSchema = z
  .object({
    owner: z.literal('provider'),
    providerDefinitionId: z.string().trim().min(1),
    methodId: z.string().trim().min(1),
  })
  .strict();

/** Reference to an authentication method owned by a native client definition. */
export const ClientAuthMethodRefSchema = z
  .object({
    owner: z.literal('client'),
    clientId: z.string().trim().min(1),
    methodId: z.string().trim().min(1),
  })
  .strict();

/** Reference to either provider-owned or client-owned authentication. */
export const AuthMethodRefSchema = z.discriminatedUnion('owner', [
  ProviderAuthMethodRefSchema,
  ClientAuthMethodRefSchema,
]);

/** Optional native account selected for an inferred authentication method. */
export const NativeAccountSelectionSchema = z
  .object({
    managerId: z.string().trim().min(1),
    accountId: z.string().trim().min(1),
  })
  .strict();

/** Lifecycle manager for a persisted provider configuration. */
export const ProviderConfigManagerSchema = z
  .object({
    kind: z.literal('client'),
    clientId: z.string().trim().min(1),
  })
  .strict();

const ExplicitProviderConfigAuthSchema = z
  .object({
    mode: z.literal('explicit'),
    method: AuthMethodRefSchema,
    credentialRefs: z
      .record(AuthFieldIdSchema, AuthCredentialRefSchema)
      .refine((refs) => Object.keys(refs).length > 0, {
        message: 'Explicit authentication must contain at least one credential ref.',
      }),
  })
  .strict();

const InferredProviderConfigAuthSchema = z
  .object({
    mode: z.literal('inferred'),
    method: ClientAuthMethodRefSchema,
    account: NativeAccountSelectionSchema.optional(),
  })
  .strict();

const NoProviderConfigAuthSchema = z
  .object({
    mode: z.literal('none'),
    method: AuthMethodRefSchema,
  })
  .strict();

/** Persisted selection of exactly one authentication mode and method. */
export const ProviderConfigAuthSchema = z.discriminatedUnion('mode', [
  ExplicitProviderConfigAuthSchema,
  InferredProviderConfigAuthSchema,
  NoProviderConfigAuthSchema,
]);

export type ProviderAuthMethodRef = z.infer<typeof ProviderAuthMethodRefSchema>;
export type ClientAuthMethodRef = z.infer<typeof ClientAuthMethodRefSchema>;
export type AuthMethodRef = z.infer<typeof AuthMethodRefSchema>;
export type AuthCredentialRef = z.infer<typeof AuthCredentialRefSchema>;
export type NativeAccountSelection = z.infer<typeof NativeAccountSelectionSchema>;
export type ProviderConfigManager = z.infer<typeof ProviderConfigManagerSchema>;
export type ProviderConfigAuth = z.infer<typeof ProviderConfigAuthSchema>;
