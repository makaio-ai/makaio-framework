/**
 * Credential namespace for the Makaio bus.
 *
 * Provides top-level bus subjects for credential CRUD and resolution,
 * keyed by `configId`. Provider-config entities use their UUID as the configId;
 * other callers (e.g., GitHub OAuth) use a well-known synthetic key such as
 * `'github:oauth-default'`.
 *
 * Channel-only subjects (`store`, `get`, `resolve`) carry sensitive credential
 * data and are rejected by the public bus. Trusted in-process callers open the
 * full credential DirectChannel via the local-only `getChannelToken` subject.
 * Browser callers can instead request a config-bound, store-only channel grant;
 * the grant request carries no plaintext and the returned DirectChannel exposes
 * neither credential reads nor resolution.
 *
 * Prefix: `credential.`
 * @example
 * ```typescript
 * // Obtain a channel token, then open a channel for sensitive operations
 * const { token } = await bus.request(CredentialSubjects.getChannelToken, {});
 * const channel = await openChannel(bus.getContext(), 'credentials', { token, transports: [] });
 *
 * // Store credentials over the local encrypted channel
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
import { createBusNamespace, channelSubject, localSubject } from '@makaio/core';
import { CredentialRefSchema } from '../config/credential-ref.js';
import { ResolvedProviderContextSchema } from '../adapter/schemas/provider-context.js';
import { CredentialChangeSequenceSchema } from './change-sequence.js';

/** Encrypted request payload for persisting a complete credential slot. */
export const CredentialStoreRequestSchema = z
  .object({
    /** Provider config UUID. */
    configId: z.string(),
    /** Credential key-value pairs to persist. */
    credentials: z.record(z.string(), z.string()),
  })
  .strict();

/** Empty response returned after an encrypted credential store succeeds. */
export const CredentialStoreResponseSchema = z.object({}).strict();

/** Plaintext-free request for a config-bound, store-only DirectChannel grant. */
export const CredentialStoreGrantRequestSchema = z
  .object({
    /** Existing disabled provider-config reservation that will own the credentials. */
    configId: z.string(),
  })
  .strict();

/** One-shot capability metadata used to open the transported store-only channel. */
export const CredentialStoreGrantResponseSchema = z
  .object({
    /** Ephemeral DirectChannel endpoint name. */
    endpoint: z.string(),
    /** Ephemeral bearer token accepted only by the returned endpoint. */
    token: z.string(),
  })
  .strict();

/** Encrypted credential store request. */
export type CredentialStoreRequest = z.infer<typeof CredentialStoreRequestSchema>;

/** Plaintext-free store-only channel grant request. */
export type CredentialStoreGrantRequest = z.infer<typeof CredentialStoreGrantRequestSchema>;

/** Store-only channel capability returned to a transported caller. */
export type CredentialStoreGrantResponse = z.infer<typeof CredentialStoreGrantResponseSchema>;

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
    request: CredentialStoreRequestSchema,
    response: CredentialStoreResponseSchema,
  }),
  /**
   * Request a one-shot, config-bound channel that exposes only `store`.
   *
   * This normal transported subject deliberately contains only a config ID and
   * capability metadata. Credential plaintext must be sent through the returned
   * DirectChannel. The host issues grants only for disabled reservations and
   * rechecks that state immediately before storage.
   */
  'storeGrant.create': {
    request: CredentialStoreGrantRequestSchema,
    response: CredentialStoreGrantResponseSchema,
  },
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
   * Awaited before credential resolution. A selected account is mandatory:
   * unavailable managers and failed activation block agent startup.
   */
  activate: {
    request: z
      .object({
        /** Complete refs-only provider context selected for adapter startup. */
        providerContext: ResolvedProviderContextSchema,
      })
      .strict(),
    response: z.discriminatedUnion('success', [
      z.object({ success: z.literal(true) }).strict(),
      z
        .object({
          success: z.literal(false),
          /** Stable failure category; secret and credential-ref values are never returned. */
          code: z.enum(['account-not-found', 'activation-failed']),
        })
        .strict(),
    ]),
  },
  /**
   * Prepare a reversible managed-account activation for an atomic connector swap.
   *
   * Local-only because the opaque transaction is owned by the in-process
   * account manager and holds its per-client mutation lock until commit or
   * rollback consumes the identifier.
   */
  'activation.prepare': localSubject({
    request: z
      .object({
        /** Complete refs-only provider context whose exact account is selected. */
        providerContext: ResolvedProviderContextSchema,
      })
      .strict(),
    response: z.discriminatedUnion('success', [
      z
        .object({
          success: z.literal(true),
          /** Opaque single-use activation transaction identifier. */
          transactionId: z.string().uuid(),
        })
        .strict(),
      z
        .object({
          success: z.literal(false),
          code: z.enum(['account-not-found', 'activation-failed']),
        })
        .strict(),
    ]),
  }),
  /** Commit one prepared account activation exactly once. */
  'activation.commit': localSubject({
    request: z.object({ transactionId: z.string().uuid() }).strict(),
    response: z.discriminatedUnion('success', [
      z.object({ success: z.literal(true) }).strict(),
      z
        .object({
          success: z.literal(false),
          code: z.enum(['transaction-not-found', 'commit-failed', 'commit-rollback-failed']),
        })
        .strict(),
    ]),
  }),
  /** Roll back one prepared account activation exactly once. */
  'activation.rollback': localSubject({
    request: z.object({ transactionId: z.string().uuid() }).strict(),
    response: z.discriminatedUnion('success', [
      z.object({ success: z.literal(true) }).strict(),
      z
        .object({
          success: z.literal(false),
          code: z.enum(['transaction-not-found', 'rollback-failed']),
        })
        .strict(),
    ]),
  }),
  /**
   * Mid-session credential rotation signal.
   *
   * Emitted when credential state changes during active sessions.
   * The orchestrator fans this out to affected agents.
   */
  changed: {
    request: z
      .object({
        /** Makaio session ID. */
        sessionId: z.string(),
        /** Monotonic per-provider-config change token used to reject stale fan-out. */
        changeSequence: CredentialChangeSequenceSchema,
        /** Complete refs-only provider context that replaces the previous selection. */
        providerContext: ResolvedProviderContextSchema,
      })
      .strict(),
    response: z.object({}).strict(),
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
export const CredentialNamespace = createBusNamespace('credential', CredentialSchemas);

/** Pre-extracted credential bus subjects for direct import. */
export const CredentialSubjects = CredentialNamespace.subjects;
