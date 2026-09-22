import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { ConfigSchema, EntityUIConfigSchema, ProtocolIdSchema } from '@makaio/contracts';
import { ProviderDefaultsSchema } from '@makaio/contracts/config';

/**
 * Readiness signal derived from canonical adapter bindings.
 *
 * - `ready`: the adapter has an enabled provider-config binding
 * - `needs-setup`: the adapter has no enabled binding; explicit setup is required
 */
export const AdapterReadinessSchema = z.enum(['ready', 'needs-setup']);

/** Readiness signal for canonical adapter configuration. */
export type AdapterReadiness = z.infer<typeof AdapterReadinessSchema>;

/**
 * Information about an adapter driver.
 * Used in adapter list responses to show available adapters and their status.
 */
export const AdapterInfoSchema = z.object({
  /** Adapter driver name (e.g., 'claude-code', 'openai-node') */
  adapterName: z.string(),
  /** Human-readable display name for UI */
  displayName: z.string(),
  /** Short description for tooltips/selection UI */
  description: z.string().optional(),
  /** Whether this adapter driver is enabled in runtime config */
  enabled: z.boolean(),
  /** Number of configured instances for this adapter */
  configCount: z.number(),
  /** Whether this adapter currently has a registered log-import provider */
  supportsLogImport: z.boolean(),
  /** Help links for documentation */
  helpLinks: z
    .array(
      z.object({
        /** Display label for the link */
        label: z.string(),
        /** URL to the resource */
        url: z.string(),
      }),
    )
    .optional(),
  /** Setup instructions in Markdown format */
  instructions: z.string().optional(),
  /** Readiness signal derived from canonical adapter bindings */
  readiness: AdapterReadinessSchema,
  /**
   * Stable client identifier this adapter belongs to (e.g. `'claude-code'`).
   * Omitted for API-only adapters that have no associated CLI client.
   */
  clientId: z.string().optional(),
  /** Wire protocol this adapter speaks (e.g., `'anthropic'`, `'openai'`). */
  protocol: ProtocolIdSchema.optional(),
  /**
   * Provider definition IDs this adapter can run against.
   *
   * This is the canonical compatibility surface for onboarding and binding
   * suggestion flows. It is more precise than `protocol` alone.
   */
  providerDefinitionIds: z.array(z.string()).optional(),
});

// ── Runtime Config ──────────────────────────────────────────────────────────

const RuntimeGetRequestSchema = z.record(z.string(), z.unknown());
const RuntimeGetResponseSchema = ConfigSchema;

const RuntimeUpdateRequestSchema = ConfigSchema.partial();
const RuntimeUpdateResponseSchema = z.object({ success: z.boolean() });

// ── Adapter Drivers ─────────────────────────────────────────────────────────

const AdapterListRequestSchema = z.record(z.string(), z.unknown());
const AdapterListResponseSchema = z.object({
  adapters: z.array(AdapterInfoSchema),
});

const AdapterSetEnabledRequestSchema = z.object({
  adapterName: z.string(),
  enabled: z.boolean(),
});
const AdapterSetEnabledResponseSchema = z.object({ success: z.boolean() });

// ── Adapter Defaults ────────────────────────────────────────────────────────

const AdapterDefaultsGetRequestSchema = z.object({
  adapterName: z.string(),
});
const AdapterDefaultsGetResponseSchema = ProviderDefaultsSchema.partial();

const AdapterDefaultsUpdateRequestSchema = z.object({
  adapterName: z.string(),
  defaults: ProviderDefaultsSchema.partial(),
});
const AdapterDefaultsUpdateResponseSchema = z.object({ success: z.boolean() });

// ── Adapter Config ──────────────────────────────────────────────────────────

const AdapterGetConfigRequestSchema = z.object({
  /** Adapter driver name */
  adapterName: z.string(),
});
const AdapterGetConfigResponseSchema = z.object({
  /** Adapter-wide configuration settings */
  config: z.record(z.string(), z.unknown()),
});

const AdapterUpdateConfigRequestSchema = z.object({
  /** Adapter driver name */
  adapterName: z.string(),
  /** Configuration settings to update */
  config: z.record(z.string(), z.unknown()),
});
const AdapterUpdateConfigResponseSchema = z.object({
  /** Whether update succeeded */
  success: z.boolean(),
});

// ── Schema Introspection ────────────────────────────────────────────────────

const JsonSchemaType = z.record(z.string(), z.unknown());

const AdapterGetConfigSchemaRequestSchema = z.object({ adapterName: z.string() });
const AdapterGetConfigSchemaResponseSchema = z.object({
  hasSchema: z.boolean(),
  schema: JsonSchemaType.nullable(),
});

const ExtensionGetConfigSchemaRequestSchema = z.object({ extensionName: z.string() });

/**
 * Snapshot of the operator-owned configuration layer exposed on schema responses.
 *
 * Present when an operator configuration source supplies values for the
 * extension. The UI layer uses this to render operator-owned fields as
 * read-only and to show provenance text identifying the source.
 *
 * The owned key set and the effective values are two separate facts and are
 * carried in two separate fields. Which keys the operator owns is always
 * knowable from the operator entry alone; which values the extension ends up
 * receiving is only knowable once its configuration resolves. Locking is
 * therefore driven exclusively by `keys`, and `values` is a display
 * convenience that may be absent.
 */
const ExtensionOperatorConfigSnapshotSchema = z.object({
  /**
   * Human-readable label identifying the operator configuration source.
   *
   * Opaque: it may be a file path, a secret-store path, or any other label.
   * Reproduced verbatim in provenance hint text shown next to locked fields.
   */
  source: z.string(),
  /**
   * Config keys owned by the operator configuration source.
   *
   * Authoritative for locking: a consumer renders exactly these fields as
   * read-only. Always present whenever an operator source supplies config for
   * the extension, whether or not its configuration could be resolved — an
   * operator-owned field must never become editable just because resolution
   * failed, since the operator layer would silently shadow the edit.
   */
  keys: z.array(z.string()),
  /**
   * Effective values for the operator-owned keys of this extension.
   *
   * Absent when the extension's configuration could not be resolved; a
   * consumer then locks the fields listed in `keys` without a value to show.
   * When present, the operator layer has the highest precedence in the merged
   * config, so these shadow whatever the stored layer holds for owned keys.
   * They are the values the extension actually receives — the merged config
   * after the extension's config schema has parsed it, so schema transforms
   * such as `.trim()` are already applied. `save()` writes the stored layer
   * verbatim, so the stored record retains its own values for operator-owned
   * keys; when the operator layer is later removed, those stored values serve
   * as the fallback.
   */
  values: z.record(z.string(), z.unknown()).optional(),
});

const ExtensionGetConfigSchemaResponseSchema = z.object({
  hasSchema: z.boolean(),
  schema: JsonSchemaType.nullable(),
  uiConfig: EntityUIConfigSchema.nullable(),
  /**
   * Operator-supplied config provenance for this extension.
   *
   * Absent when no operator configuration source supplies values for this
   * extension. The UI layer uses this to mark owned keys as disabled and show
   * a provenance hint.
   */
  operatorConfig: ExtensionOperatorConfigSnapshotSchema.optional(),
});

// ── Aggregate ───────────────────────────────────────────────────────────────

/**
 * Settings domain schemas for adapter-level operations.
 *
 * Each key becomes a subject identifier as: `settings.{key}`
 */
export const SettingsSchemas = {
  /** Get current runtime configuration (subject: `settings.runtime.get`) */
  'runtime.get': {
    request: RuntimeGetRequestSchema,
    response: RuntimeGetResponseSchema,
  },

  /** Update runtime configuration (subject: `settings.runtime.update`) */
  'runtime.update': {
    request: RuntimeUpdateRequestSchema,
    response: RuntimeUpdateResponseSchema,
  },

  /** List all available adapter drivers (subject: `settings.adapter.list`) */
  'adapter.list': {
    request: AdapterListRequestSchema,
    response: AdapterListResponseSchema,
  },

  /** Enable or disable an adapter driver (subject: `settings.adapter.setEnabled`) */
  'adapter.setEnabled': {
    request: AdapterSetEnabledRequestSchema,
    response: AdapterSetEnabledResponseSchema,
  },

  /** Get adapter-level defaults (subject: `settings.adapter.defaults.get`) */
  'adapter.defaults.get': {
    request: AdapterDefaultsGetRequestSchema,
    response: AdapterDefaultsGetResponseSchema,
  },

  /** Update adapter-level defaults (subject: `settings.adapter.defaults.update`) */
  'adapter.defaults.update': {
    request: AdapterDefaultsUpdateRequestSchema,
    response: AdapterDefaultsUpdateResponseSchema,
  },

  /** Get adapter-wide configuration (subject: `settings.adapter.getConfig`) */
  'adapter.getConfig': {
    request: AdapterGetConfigRequestSchema,
    response: AdapterGetConfigResponseSchema,
  },

  /** Update adapter-wide configuration (subject: `settings.adapter.updateConfig`) */
  'adapter.updateConfig': {
    request: AdapterUpdateConfigRequestSchema,
    response: AdapterUpdateConfigResponseSchema,
  },

  /** Get JSON Schema for adapter's providerConfig (subject: `settings.adapter.getConfigSchema`) */
  'adapter.getConfigSchema': {
    request: AdapterGetConfigSchemaRequestSchema,
    response: AdapterGetConfigSchemaResponseSchema,
  },

  /** Get JSON Schema for extension's configSchema (subject: `settings.extension.getConfigSchema`) */
  'extension.getConfigSchema': {
    request: ExtensionGetConfigSchemaRequestSchema,
    response: ExtensionGetConfigSchemaResponseSchema,
  },
} satisfies SchemaRecord;
