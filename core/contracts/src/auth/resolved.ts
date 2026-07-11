import { z } from 'zod';
import {
  AuthFieldIdSchema,
  ExplicitAuthMethodDefinitionSchema,
  InferredAuthMethodDefinitionSchema,
  NoAuthMethodDefinitionSchema,
} from './definitions.js';
import {
  AuthCredentialRefSchema,
  AuthMethodRefSchema,
  ClientAuthMethodRefSchema,
  NativeAccountSelectionSchema,
} from './selection.js';

const ResolvedExplicitProviderAuthSchema = z
  .object({
    mode: z.literal('explicit'),
    method: AuthMethodRefSchema,
    definition: ExplicitAuthMethodDefinitionSchema,
    credentialRefs: z.record(AuthFieldIdSchema, AuthCredentialRefSchema),
  })
  .strict();

const ResolvedInferredProviderAuthSchema = z
  .object({
    mode: z.literal('inferred'),
    method: ClientAuthMethodRefSchema,
    definition: InferredAuthMethodDefinitionSchema,
    account: NativeAccountSelectionSchema.optional(),
  })
  .strict();

const ResolvedNoProviderAuthSchema = z
  .object({
    mode: z.literal('none'),
    method: AuthMethodRefSchema,
    definition: NoAuthMethodDefinitionSchema,
  })
  .strict();

/**
 * Provider authentication after the selected static method has been resolved.
 * Plaintext values are deliberately absent; explicit credentials remain refs.
 */
export const ResolvedProviderAuthSchema = z
  .discriminatedUnion('mode', [
    ResolvedExplicitProviderAuthSchema,
    ResolvedInferredProviderAuthSchema,
    ResolvedNoProviderAuthSchema,
  ])
  .superRefine((auth, ctx) => {
    if (auth.method.methodId !== auth.definition.id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Resolved auth method reference must match the resolved method definition ID.',
        path: ['definition', 'id'],
      });
    }

    if (auth.mode !== 'explicit') {
      return;
    }

    const knownFieldIds = new Set(auth.definition.fields.map(({ id }) => id));
    for (const field of auth.definition.fields) {
      if (field.required && !Object.prototype.hasOwnProperty.call(auth.credentialRefs, field.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Missing required credential ref for field "${field.id}".`,
          path: ['credentialRefs', field.id],
        });
      }
    }

    for (const fieldId of Object.keys(auth.credentialRefs)) {
      if (!knownFieldIds.has(fieldId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Credential ref field "${fieldId}" is not declared by the resolved auth method.`,
          path: ['credentialRefs', fieldId],
        });
      }
    }
  });

export type ResolvedProviderAuth = z.infer<typeof ResolvedProviderAuthSchema>;

// `ResolvedAdapterAuth` is intentionally absent from this static contract
// domain. It contains connector-local plaintext delivery and config-inheritance
// state, so its contract belongs to Adapter Core at the trusted runtime seam.
