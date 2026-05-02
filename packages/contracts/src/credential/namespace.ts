/**
 * Credential namespace for the Makaio bus.
 *
 * Provides top-level bus subjects for credential CRUD and resolution,
 * keyed by `configId`. Provider-config entities use their UUID as the configId;
 * other callers (e.g., GitHub OAuth) use a well-known synthetic key such as
 * `'github:oauth-default'`.
 *
 * Channel-only subjects (`store`, `get`, `resolve`) carry sensitive credential
 * data and are rejected by the public bus. Callers must open a DirectChannel
 * via the `getChannelToken` subject before using them. `getChannelToken` itself
 * is local-only — it is never routed to remote transports — so only in-process
 * bus participants can request the capability token.
 *
 * Prefix: `credential.`
 * @example
 * ```typescript
 * // Obtain a channel token, then open a channel for sensitive operations
 * const { token } = await bus.request(CredentialSubjects.getChannelToken, {});
 * const channel = await openChannel(bus.getContext(), 'credentials', { token, transports: [] });
 *
 * // Store credentials over the encrypted channel
 * await channel.request(CredentialSubjects.store, {
 *   configId: 'uuid-here',
 *   credentials: { apiKey: 'sk-...' },
 * });
 *
 * // Resolve a credential reference over the encrypted channel
 * const { value } = await channel.request(CredentialSubjects.resolve, { ref });
 * ```
 * @packageDocumentation
 */

import { z } from 'zod';
import { MakaioBus, channelSubject, localSubject } from '@makaio/bus-core';
import { CredentialRefSchema } from '../config/credential-ref.js';
import { CredentialChangeSequenceSchema } from './change-sequence.js';

/**
 * Zod schemas for all credential bus subjects.
 *
 * Each entry becomes a subject identifier as `credential.<key>`.
 *
 * Channel-only subjects (`store`, `get`, `resolve`) are rejected by public bus
 * methods and must be used over a DirectChannel opened via `getChannelToken`.
 */
const CredentialSchemas = {
  /**
   * Store credentials for a provider config.
   * Channel-only — carries sensitive credential data.
   */
  store: channelSubject({
    request: z.object({
      /** Provider config UUID. */
      configId: z.string(),
      /** Credential key-value pairs to persist. */
      credentials: z.record(z.string(), z.string()),
    }),
    response: z.object({}),
  }),
  /**
   * Retrieve stored credentials for a provider config.
   * Channel-only — carries sensitive credential data.
   */
  get: channelSubject({
    request: z.object({
      /** Provider config UUID. */
      configId: z.string(),
    }),
    response: z.object({
      /** Stored credentials, or `null` when none are found. */
      credentials: z.record(z.string(), z.string()).nullable(),
    }),
  }),
  /** Check whether credentials exist for a provider config. */
  exists: {
    request: z.object({
      /** Provider config UUID. */
      configId: z.string(),
    }),
    response: z.object({
      /** `true` when at least one credential is stored. */
      exists: z.boolean(),
    }),
  },
  /** Delete stored credentials for a provider config. */
  delete: {
    request: z.object({
      /** Provider config UUID. */
      configId: z.string(),
    }),
    response: z.object({
      /** `true` when credentials were found and deleted. */
      deleted: z.boolean(),
    }),
  },
  /**
   * Pre-resolution activation hook for credential extensions.
   *
   * Emitted before `resolveConnectorCredentials()` runs so extensions
   * (e.g., account-manager) can prepare native credential stores.
   * Awaited before credential resolution — handler failures are suppressed
   * (errors cannot block agent start), but completion is guaranteed before
   * `resolveConnectorCredentials()` runs.
   */
  activate: {
    request: z.object({
      /** Provider config UUID. */
      providerConfigId: z.string(),
      /** Provider definition ID (e.g., `'anthropic'`). */
      definitionId: z.string(),
      /** Credential references that will be resolved after activation. */
      credentialRefs: z.record(z.string(), CredentialRefSchema),
    }),
    response: z.object({}),
  },
  /**
   * Mid-session credential rotation signal.
   *
   * Emitted when credential state changes during active sessions.
   * The orchestrator fans this out to affected agents.
   */
  changed: {
    request: z.object({
      /** Makaio session ID. */
      sessionId: z.string(),
      /** Provider config UUID. */
      providerConfigId: z.string(),
      /** Provider definition ID. */
      definitionId: z.string(),
      /** Monotonic per-provider-config change token used to reject stale fan-out. */
      changeSequence: CredentialChangeSequenceSchema,
      /** Updated credential references. */
      credentialRefs: z.record(z.string(), CredentialRefSchema),
    }),
    response: z.object({}),
  },
  /**
   * Resolve a credential reference to its plaintext value.
   * Channel-only — the resolved value is sensitive.
   */
  resolve: channelSubject({
    request: z.object({
      /** Branded credential reference string. */
      ref: CredentialRefSchema,
    }),
    response: z.object({
      /** Resolved plaintext value, or `null` when unavailable. */
      value: z.string().nullable(),
      /** Human-readable error message when resolution failed. */
      error: z.string().optional(),
    }),
  }),
  /**
   * Request the credential channel capability token (local-only).
   *
   * The token grants access to encrypted credential operations. This subject
   * is local-only to prevent the token from leaking to remote transports.
   * The runtime distributes this token only to authorized services during
   * initialization.
   */
  getChannelToken: localSubject({
    request: z.object({}),
    response: z.object({
      /** Capability token to pass to `openChannel` for the `'credentials'` endpoint. */
      token: z.string(),
    }),
  }),
};

/** Credential service namespace registered under the `credential` prefix. */
export const CredentialNamespace = MakaioBus.registerNamespace('credential', CredentialSchemas);

/** Pre-extracted credential bus subjects for direct import. */
export const CredentialSubjects = CredentialNamespace.subjects;
