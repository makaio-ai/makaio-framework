import { z } from 'zod';
import { ProtocolEndpointsSchema, ProviderCapabilitiesSchema } from '../../provider/definition.js';
import { CredentialRefSchema } from '../../config/credential-ref.js';

/**
 * Unresolved provider context passed on the public bus.
 *
 * Carries credential references (not plaintext) so credentials never
 * travel on the public bus. Connectors call `resolveConnectorCredentials()`
 * to obtain plaintext locally.
 */
export const ProviderContextSchema = z.object({
  /** Provider config UUID. Links back to the ProviderConfig that produced this context. */
  providerConfigId: z.string(),

  /** Provider definition ID (e.g., `'anthropic'`, `'alibaba'`). */
  definitionId: z.string(),

  /** Endpoint URL overrides keyed by protocol. */
  endpointOverrides: ProtocolEndpointsSchema.optional(),

  /** Credential references resolved at the connector layer, not on the bus. */
  credentialRefs: z.record(z.string(), CredentialRefSchema),

  /**
   * Maps credential keys to environment variable names for subprocess adapters.
   * E.g., `{ apiKey: 'ANTHROPIC_API_KEY' }`.
   */
  credentialEnvVars: z.record(z.string(), z.string()).optional(),

  /**
   * Provider credential environment variables known to the host.
   *
   * Subprocess adapters remove these from ambient `process.env` before spawning
   * clients, then add back only credentials explicitly resolved from
   * `credentialRefs`.
   */
  ambientCredentialEnvVars: z.array(z.string()).optional(),

  /**
   * Provider-declared capability hints forwarded from the provider definition.
   *
   * Opaque to the bus — adapters narrow-cast to protocol-specific types
   * at the connector layer for feature detection (e.g., structured output
   * modes, tool-call semantics).
   */
  capabilities: ProviderCapabilitiesSchema.optional(),
});

/**
 * Inferred type for an unresolved provider context.
 */
export type ProviderContext = z.infer<typeof ProviderContextSchema>;
