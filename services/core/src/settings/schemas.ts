import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { ConfigSchema, EntityUIConfigSchema, ProtocolIdSchema } from '@makaio/contracts';
import { ProviderDefaultsSchema } from '@makaio/contracts/config';

/**
 * Readiness signal: whether this adapter can operate with zero explicit config.
 *
 * - `ready`: adapter has a default preset and all required credentials are available
 * - `missing-credentials`: adapter has a default preset but required credential env vars are not set
 * - `needs-setup`: adapter has no default preset or preset metadata; explicit setup is required
 */
export const AdapterReadinessSchema = z.enum(['ready', 'missing-credentials', 'needs-setup']);

/** Readiness signal for zero-config adapter enablement. */
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
  /** Readiness signal: whether this adapter can operate with zero explicit config */
  readiness: AdapterReadinessSchema.optional(),
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
const ExtensionGetConfigSchemaResponseSchema = z.object({
  hasSchema: z.boolean(),
  schema: JsonSchemaType.nullable(),
  uiConfig: EntityUIConfigSchema.nullable(),
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
