import { z } from 'zod';
import { ProtocolEndpointsSchema, ProviderCapabilitiesSchema } from '../../provider/definition.js';
import { ResolvedProviderAuthSchema } from '../../auth/resolved.js';

/**
 * Provider context whose persisted config and authentication method were
 * resolved against the current provider/client definitions.
 */
export const ResolvedProviderContextSchema = z
  .object({
    state: z.literal('resolved'),

    /** Provider config ID. Links back to the config that produced this snapshot. */
    providerConfigId: z.string().trim().min(1),

    /** Provider definition ID (e.g., `'anthropic'`, `'alibaba'`). */
    definitionId: z.string().trim().min(1),

    /** Endpoint URL overrides keyed by protocol. */
    endpointOverrides: ProtocolEndpointsSchema.optional(),

    /** Normalized auth selection with refs only; plaintext is never bus-visible. */
    auth: ResolvedProviderAuthSchema,

    /** Provider-declared capability hints interpreted by concrete adapters. */
    capabilities: ProviderCapabilitiesSchema.optional(),
  })
  .strict()
  .superRefine((context, ctx) => {
    if (context.auth.method.owner === 'provider' && context.auth.method.providerDefinitionId !== context.definitionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provider-owned authentication must belong to the resolved provider definition.',
        path: ['auth', 'method', 'providerDefinitionId'],
      });
    }
  });

/**
 * Deliberately configless provider state.
 *
 * This state carries no partial provider or auth fields, so it cannot be
 * misread as native authentication or an ambient-credential fallback.
 */
export const UnresolvedProviderContextSchema = z.object({ state: z.literal('unresolved') }).strict();

/** Public refs-only provider execution context. */
export const ProviderContextSchema = z.discriminatedUnion('state', [
  ResolvedProviderContextSchema,
  UnresolvedProviderContextSchema,
]);

/** Provider context with a validated provider config and auth method. */
export type ResolvedProviderContext = z.infer<typeof ResolvedProviderContextSchema>;

/** Deliberately configless provider context. */
export type UnresolvedProviderContext = z.infer<typeof UnresolvedProviderContextSchema>;

/** Runtime provider context union. */
export type ProviderContext = z.infer<typeof ProviderContextSchema>;
