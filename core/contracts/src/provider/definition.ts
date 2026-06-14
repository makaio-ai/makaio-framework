import { z } from 'zod';
import { AIModelSchema } from '../model/schemas.js';
import { ModelFilterModeSchema } from './visibility.js';

/**
 * Wire protocol identifiers supported by Makaio adapters.
 *
 * Each value corresponds to an inference wire protocol:
 * - `'anthropic'` — Anthropic Messages API (streaming via SSE)
 * - `'openai'`    — OpenAI Chat Completions API (streaming via SSE)
 */
export const ProtocolIdSchema = z.enum(['anthropic', 'openai']);

/**
 * Inferred union type for supported wire protocols.
 */
export type ProtocolId = z.infer<typeof ProtocolIdSchema>;

/**
 * Maps wire protocol identifiers to their base endpoint URLs.
 *
 * A provider may support multiple protocols simultaneously — for example,
 * Z.AI exposes both an Anthropic-compatible and an OpenAI-compatible endpoint.
 * Omit a protocol key when the provider does not support it.
 * @example Z.AI dual-protocol provider
 * ```ts
 * {
 *   anthropic: 'https://api.z.ai/v1/anthropic',
 *   openai: 'https://api.z.ai/v1/openai',
 * }
 * ```
 */
export const ProtocolEndpointsSchema = z
  .object({
    anthropic: z.string().url(),
    openai: z.string().url(),
  })
  .partial()
  .refine((obj) => Object.keys(obj).length > 0, {
    message: 'At least one protocol endpoint must be specified',
  });

/**
 * Inferred type for a protocol-to-endpoint mapping.
 */
export type ProtocolEndpoints = z.infer<typeof ProtocolEndpointsSchema>;

/**
 * Provider definition schema.
 *
 * The canonical parsed provider contract. Defines the stable identity,
 * display metadata, protocol endpoints, runtime-populated model catalog, and
 * credential environment variables for a single inference provider.
 *
 * Static provider packages should declare {@link ProviderDefinitionInput}:
 * they describe what a provider *is*, not how it is configured at runtime.
 * The runtime layer (storage, sync service, model registry) derives parsed
 * provider definitions and per-user provider records from those declarations.
 *
 * Providers that do not communicate over a network (e.g., GitHub Copilot,
 * which uses its own SDK transport) omit `endpoints`.
 * @example Anthropic provider definition
 * ```ts
 * {
 *   id: 'anthropic',
 *   name: 'Anthropic',
 *   description: 'Official Anthropic Claude API',
 *   endpoints: { anthropic: 'https://api.anthropic.com' },
 *   defaultModel: 'claude-sonnet-4-5',
 *   fastModel: 'claude-haiku-4-5',
 *   credentialEnvVars: { apiKey: 'ANTHROPIC_API_KEY' },
 * }
 * ```
 * `availableModels` is omitted — the registry service populates it from the
 * YAML lab registry at boot time and defaults to `[]` when absent.
 */
export const ProviderDefinitionSchema = z.object({
  /**
   * Stable provider identifier used for persistence and matching (e.g., `'anthropic'`, `'z-ai'`).
   *
   * Acts as the primary key across all provider-related storage and bus messages.
   * Must be unique across all registered provider packages.
   */
  id: z.string().min(1),

  /**
   * Display name shown in the UI (e.g., `'Anthropic'`, `'Z.AI'`).
   */
  name: z.string().min(1),

  /**
   * Short human-readable description of the provider.
   */
  description: z.string().optional(),

  /**
   * Wire protocol endpoints for this provider.
   *
   * Maps each supported protocol to a base URL. Omit for SDK-only providers
   * (e.g., GitHub Copilot) that communicate through a proprietary transport.
   */
  endpoints: ProtocolEndpointsSchema.optional(),

  /**
   * Default model identifier for general-purpose tasks (e.g., `'claude-sonnet-4-5'`).
   * Optional — providers with fully dynamic model discovery may omit this.
   */
  defaultModel: z.string().optional(),

  /**
   * Fast/cheap model for cost-sensitive operations (e.g., `'claude-haiku-4-5'`).
   * Used for subagent exploration and background processing.
   * Falls back to `defaultModel` when omitted.
   */
  fastModel: z.string().optional(),

  /**
   * Primary model used by conformance tests.
   * Falls back to `fastModel ?? defaultModel` when omitted.
   */
  primaryTestModel: z.string().optional(),

  /**
   * Secondary model used by lifecycle mutation conformance tests.
   * Falls back to `defaultModel` when omitted.
   */
  secondaryTestModel: z.string().optional(),

  /**
   * Runtime-populated model catalog for this provider.
   *
   * At boot the registry service merges lab definitions with provider-specific
   * overrides and injects the result here. Static provider packages and fixtures
   * should omit this field from {@link ProviderDefinitionInput}; the registry
   * service owns the content. Defaults to `[]` on parsed definitions so runtime
   * callers never need to handle `undefined`.
   */
  availableModels: z.array(AIModelSchema).default([]),

  /**
   * Recommended default filter mode applied when a provider record is first created.
   *
   * - `'show-all'`  — all models visible by default (curated providers like Anthropic).
   * - `'allowlist'` — all models hidden by default (firehose providers like OpenRouter).
   *
   * Defaults to `'show-all'` in the sync service when omitted.
   */
  defaultModelFilterMode: ModelFilterModeSchema.optional(),

  /**
   * Environment variable names for credential fields.
   *
   * Maps credential field names (matching the adapter's `credentialSchema` keys)
   * to environment variable names. Used as last-resort fallback when credentials
   * are not provided via saved config or runtime input.
   * @example `{ apiKey: 'ANTHROPIC_API_KEY' }` or `{ token: 'COPILOT_TOKEN' }`
   */
  credentialEnvVars: z.record(z.string(), z.string()).optional(),

  /**
   * Free-form bag of protocol-specific capability hints.
   *
   * Opaque to the framework — adapters narrow-cast to protocol-specific types
   * at the connector layer. Provider packages declare capabilities that their
   * endpoints natively support (e.g., structured output modes, tool-call
   * features) so adapters can select the optimal code path without maintaining
   * hardcoded provider ID sets.
   * @example OpenAI structured output capabilities
   * ```ts
   * {
   *   structuredOutput: {
   *     responseFormatWithTools: true,
   *     strict: true,
   *   },
   * }
   * ```
   */
  capabilities: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Inferred output type for a fully-parsed provider definition.
 *
 * Fields with `.default()` (e.g., `availableModels`) are always present here.
 * Use this type for runtime consumers that read provider definition values.
 */
export type ProviderDefinition = z.infer<typeof ProviderDefinitionSchema>;

/**
 * Input type for provider definition declarations.
 *
 * Fields with `.default()` (e.g., `availableModels`) are optional here —
 * the registry service populates them from YAML at boot time.
 * Use this type when declaring a static `providerDefinition` constant in a
 * provider package so that `availableModels` may be omitted.
 */
export type ProviderDefinitionInput = z.input<typeof ProviderDefinitionSchema>;
