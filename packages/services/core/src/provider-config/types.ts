import { z } from 'zod';
import { CredentialRefSchema, isCanonicalProviderConfigName } from '@makaio/contracts/config';
import {
  ProtocolEndpointsSchema,
  ProtocolIdSchema,
  ModelFilterModeSchema,
  ModelVisibilitySchema,
} from '@makaio/contracts/provider';

/**
 * Permissive partial protocol endpoints schema for reading from storage.
 *
 * Does NOT include the `.refine()` requiring at least one key — a stored empty
 * `{}` must not throw during deserialization. The mapper converts empty objects
 * to `undefined` before returning them to callers.
 */
const StoredProtocolEndpointsSchema = z
  .object({
    anthropic: z.string().url(),
    openai: z.string().url(),
  })
  .partial();

/**
 * Schema for a provider config record returned from storage.
 *
 * Credentials are branded {@link CredentialRef} values so callers cannot
 * accidentally compare or log raw secret strings.
 */
export const ProviderConfigRecordSchema = z.object({
  /** Canonical provider config ID (file stem). */
  id: z.string(),
  /** FK to providers.id — links this config to a discovered provider package. */
  definitionId: z.string(),
  /** Display name for UI. */
  name: z.string(),
  /** Saved credential references, keyed by credential field name. */
  credentials: z.record(z.string(), CredentialRefSchema).optional(),
  /** Per-protocol endpoint overrides; absent when not customised. */
  endpointOverrides: StoredProtocolEndpointsSchema.optional(),
  /** Sparse per-model visibility overrides. */
  modelVisibility: z.record(z.string(), ModelVisibilitySchema).optional(),
  /** Controls default visibility for models without explicit overrides. */
  modelFilterMode: ModelFilterModeSchema,
  /** Whether this is the default config for its provider definition. */
  isDefault: z.boolean(),
  /** Whether this config is enabled; disabled configs are not loaded. */
  enabled: z.boolean(),
  /**
   * True for system-created configs representing a client's built-in auth.
   * Sentinel configs are enable/disable only — not user-creatable or deletable.
   */
  isSentinel: z.boolean().default(false),
  /** Timestamp when record was created (Unix milliseconds). */
  createdAt: z.number(),
  /** Timestamp when record was last updated (Unix milliseconds). */
  updatedAt: z.number(),
});

/**
 * Inferred type for a provider config record.
 */
export type ProviderConfigRecord = z.infer<typeof ProviderConfigRecordSchema>;

/**
 * Schema for storage-tier upsert input.
 *
 * The caller provides the canonical file-stem `id`. Timestamps are managed by the storage
 * handler. Credentials are plain strings here — the mapper brands them on
 * output via {@link brandCredentialRecord}.
 */
export const ProviderConfigInputSchema = z.object({
  /** Canonical provider config ID — caller-supplied for upsert. */
  id: z.string(),
  /** FK to providers.id. */
  definitionId: z.string(),
  /** Display name for UI. */
  name: z.string(),
  /** Plain string credentials keyed by field name. */
  credentials: z.record(z.string(), z.string()).optional(),
  /** Per-protocol endpoint overrides. */
  endpointOverrides: ProtocolEndpointsSchema.optional(),
  /** Sparse per-model visibility overrides. */
  modelVisibility: z.record(z.string(), ModelVisibilitySchema).optional(),
  /** Controls default visibility for models without explicit overrides. */
  modelFilterMode: ModelFilterModeSchema,
  /** Whether this is the default config for its provider definition. */
  isDefault: z.boolean(),
  /** Whether this config is enabled. */
  enabled: z.boolean(),
  /**
   * True for system-created configs representing a client's built-in auth.
   * Sentinel configs are enable/disable only — not user-creatable or deletable.
   */
  isSentinel: z.boolean(),
});

/**
 * Inferred type for storage-tier upsert input.
 */
export type ProviderConfigInput = z.infer<typeof ProviderConfigInputSchema>;

/**
 * Lightweight summary schema for list responses.
 *
 * `hasCredentials` is derived — it reflects whether at least one credential
 * key is stored, without exposing credential values.
 *
 * `supportedProtocols` is derived from the provider definition's `endpoints`
 * keys at list time. It enables callers (e.g., AdaptersStep, SettingsView) to
 * filter bindings without an additional provider-definition lookup.
 */
export const ProviderConfigSummarySchema = z.object({
  /** Canonical provider config ID (file stem). */
  id: z.string(),
  /** FK to providers.id. */
  definitionId: z.string(),
  /** Display name for UI. */
  name: z.string(),
  /** Sparse per-model visibility overrides. */
  modelVisibility: z.record(z.string(), ModelVisibilitySchema).optional(),
  /** Controls default visibility for models without explicit overrides. */
  modelFilterMode: ModelFilterModeSchema,
  /** Whether this is the default config for its provider definition. */
  isDefault: z.boolean(),
  /** Whether this config is enabled. */
  enabled: z.boolean(),
  /**
   * True for system-created configs representing a client's built-in auth.
   * Sentinel configs are enable/disable only — not user-creatable or deletable.
   */
  isSentinel: z.boolean(),
  /** True when at least one credential key exists in storage. */
  hasCredentials: z.boolean(),
  /**
   * Wire protocols this provider config supports, derived from the provider
   * definition's `endpoints` map keys. Empty when the provider has no declared
   * endpoints (e.g., SDK-only providers like GitHub Copilot).
   */
  supportedProtocols: z.array(ProtocolIdSchema),
  /**
   * Opaque credential source identifier derived from credential refs.
   *
   * Used for matching configs to external account sources (e.g., account-manager
   * accounts) without exposing credential values. Set when at least one
   * credential ref uses a known external-source format (e.g., `account-manager:`
   * prefix); absent otherwise.
   */
  sourceRef: z.string().optional(),
});

/**
 * Inferred type for a provider config summary.
 */
export type ProviderConfigSummary = z.infer<typeof ProviderConfigSummarySchema>;

/**
 * Returns true when the given provider config name does not contain characters
 * reserved by the canonical model grammar (`::`, `~`, `/`) **and** produces a
 * non-empty slug that matches the routing-segment pattern
 * `^[a-z0-9][a-z0-9._-]*$`.
 *
 * Intended for use as a Zod `.refine()` predicate.
 * @param name - The candidate provider config name, or `undefined` when the
 *   field is optional and was not supplied.
 * @returns `true` if the name is absent, free of reserved characters, and
 *   slugifies to a valid routing segment; `false` otherwise.
 */
function isValidProviderConfigName(name: string | undefined): boolean {
  return name === undefined ? true : isCanonicalProviderConfigName(name);
}

/**
 * Shared refinement options for the `name` field character restrictions.
 *
 * Names must not contain `::`, `~`, or `/`, and must slugify via
 * {@link slugifyProviderConfigName} to a string matching
 * `^[a-z0-9][a-z0-9._-]*$` so the config can be addressed via canonical model
 * routing.
 */
const providerConfigNameRefinement = {
  message:
    'Provider config name must not contain "::", "~", or "/", and must slugify to a valid routing segment ' +
    '(lowercase letters, digits, underscores, hyphens, and dots; must start with a letter or digit).',
  path: ['name'],
};

/**
 * Schema for service-tier config creation.
 *
 * No `id` (generated by service), no `isDefault` (managed by service).
 * `name` may be omitted — the service derives it from the definition name.
 */
export const CreateProviderConfigInputSchema = z
  .object({
    /** FK to providers.id. */
    definitionId: z.string(),
    /** Display name; omit to auto-derive from the definition's name. */
    name: z.string().optional(),
    /** Plain string credentials keyed by field name. */
    credentials: z.record(z.string(), z.string()).optional(),
    /**
     * Pre-resolved credential refs keyed by field name.
     *
     * Use this when the config should point at an external credential owner
     * (for example `account-manager:["<clientId>","<accountId>"]`) instead of
     * storing a new secret in the Makaio credential store.
     */
    credentialRefs: z.record(z.string(), CredentialRefSchema).optional(),
    /** Per-protocol endpoint overrides. */
    endpointOverrides: ProtocolEndpointsSchema.optional(),
    /** Sparse per-model visibility overrides. */
    modelVisibility: z.record(z.string(), ModelVisibilitySchema).optional(),
    /** Controls default visibility for models without explicit overrides. */
    modelFilterMode: ModelFilterModeSchema.optional(),
    /**
     * True for system-created configs representing a client's built-in auth.
     * Sentinel configs are enable/disable only and persist as file-backed records.
     */
    isSentinel: z.boolean().optional(),
  })
  .refine((input) => !(input.credentials && input.credentialRefs), {
    message: 'Provide either credentials or credentialRefs, not both.',
    path: ['credentialRefs'],
  })
  .refine((input) => isValidProviderConfigName(input.name), providerConfigNameRefinement);

/**
 * Inferred type for service-tier config creation.
 */
export type CreateProviderConfigInput = z.infer<typeof CreateProviderConfigInputSchema>;

/**
 * Schema for service-tier partial updates.
 *
 * All fields are optional — only supplied keys are updated.
 *
 * `isDefault` and `modelFilterMode` are intentionally excluded — they require
 * invariant enforcement (single-default-per-definition, allowlist-keeper) that
 * the dedicated `setDefault` and `setModelFilterMode` RPCs provide. Allowing
 * them in a generic patch would bypass those checks.
 *
 * `endpointOverrides` accepts `null` to explicitly clear previously stored
 * overrides. Omitting the field leaves existing overrides unchanged.
 */
export const ProviderConfigPatchSchema = z
  .object({
    /** Display name for UI. */
    name: z.string().optional(),
    /**
     * Per-protocol endpoint overrides. Pass `null` to clear existing overrides;
     * omit to leave them unchanged.
     */
    endpointOverrides: z.union([ProtocolEndpointsSchema, z.null()]).optional(),
    /** Sparse per-model visibility overrides. */
    modelVisibility: z.record(z.string(), ModelVisibilitySchema).optional(),
    /** Whether this config is enabled. */
    enabled: z.boolean().optional(),
  })
  .refine((input) => isValidProviderConfigName(input.name), providerConfigNameRefinement);

/**
 * Inferred type for service-tier partial updates.
 */
export type ProviderConfigPatch = z.infer<typeof ProviderConfigPatchSchema>;
