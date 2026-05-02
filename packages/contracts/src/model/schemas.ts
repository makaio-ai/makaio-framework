import { z } from 'zod';
import { STT_MODE_LITERALS, TTS_MODE_LITERALS } from '../capabilities/voice/modes.js';

/**
 * Standardized reasoning levels used across the Makaio Framework.
 *
 * These are provider-agnostic labels that adapters map to native values
 * (token budgets, effort strings, etc.) via `ReasoningLevelMapSchema`.
 */
export const AIReasoningLevelSchema = z.enum(['none', 'low', 'medium', 'high', 'extra-high']);

/**
 * Inferred union type for reasoning levels.
 */
export type AIReasoningLevel = z.infer<typeof AIReasoningLevelSchema>;

/**
 * Maps standardized reasoning levels to provider-native values.
 *
 * The value type depends on the provider:
 * - `number` — token budget (Claude: 0–32000, Gemini: 0–16384)
 * - `string` — effort label (OpenAI/Codex: 'low', 'medium', 'high', 'xhigh')
 *
 * Only supported levels are present — absence means "not supported by this model".
 * @example Claude model
 * ```ts
 * { none: 0, low: 4000, medium: 8000, high: 16000, 'extra-high': 32000 }
 * ```
 * @example Codex model
 * ```ts
 * { low: 'low', medium: 'medium', high: 'high' }
 * ```
 */
const reasoningLevelValue = z.union([z.number(), z.string()]);

export const ReasoningLevelMapSchema = z
  .object({
    none: reasoningLevelValue,
    low: reasoningLevelValue,
    medium: reasoningLevelValue,
    high: reasoningLevelValue,
    'extra-high': reasoningLevelValue,
  })
  .partial();

/**
 * Inferred type for reasoning level mappings.
 */
export type ReasoningLevelMap = z.infer<typeof ReasoningLevelMapSchema>;

/**
 * Capabilities of a speech-to-text model.
 *
 * Presence on a model's capabilities indicates STT support;
 * absence means unknown or unsupported.
 */
export const STTCapabilitySchema = z.object({
  /** Supported transcription modes. */
  modes: z.array(z.enum(STT_MODE_LITERALS)).nonempty(),
  /**
   * Whether the model supports vocabulary/terminology biasing.
   * Optional by design because model metadata can be partial, unlike provider runtime capabilities.
   */
  vocabularyBiasing: z.boolean().optional(),
});

/** Inferred STT capability type. */
export type STTCapability = z.infer<typeof STTCapabilitySchema>;

/**
 * Capabilities of a text-to-speech model.
 *
 * Presence on a model's capabilities indicates TTS support;
 * absence means unknown or unsupported.
 */
export const TTSCapabilitySchema = z.object({
  /** Supported synthesis modes. */
  modes: z.array(z.enum(TTS_MODE_LITERALS)).nonempty(),
  /** Whether the user can select a voice preset. Optional because model metadata may omit it. */
  voiceSelection: z.boolean().optional(),
  /** Whether the model supports style/tone instructions (e.g., gpt-4o-mini-tts). Optional because metadata may omit it. */
  voiceInstructions: z.boolean().optional(),
  /** Supported output audio formats. Optional because metadata may omit it. */
  outputFormats: z.array(z.string()).optional(),
});

/** Inferred TTS capability type. */
export type TTSCapability = z.infer<typeof TTSCapabilitySchema>;

/**
 * Provider-scoped model capabilities.
 *
 * All fields are optional — absence means unknown, not unsupported.
 * Values depend on the provider's API, not just the underlying model
 * (e.g., a provider may not expose tool calling even if the model supports it).
 * `imageGeneration` is an intentional future seam and would use
 * `ImageGenCapabilitySchema` once providers expose that capability here.
 */
export const AIModelCapabilitiesSchema = z.object({
  /** Whether the model accepts image inputs. */
  vision: z.boolean().optional(),
  /** Whether the provider's API supports tool/function calling. */
  toolCalling: z.boolean().optional(),
  /** Whether multiple tool calls can be issued in a single turn. */
  parallelToolCalls: z.boolean().optional(),
  /** Whether the provider supports structured (JSON schema) output. */
  structuredOutput: z.boolean().optional(),
  /** Whether the provider accepts PDF file uploads. */
  pdfUpload: z.boolean().optional(),
  // --- media capabilities ---
  /** Speech-to-text capability descriptor. */
  speechToText: STTCapabilitySchema.optional(),
  /** Text-to-speech capability descriptor. */
  textToSpeech: TTSCapabilitySchema.optional(),
});

/**
 * Inferred type for model capabilities.
 */
export type AIModelCapabilities = z.infer<typeof AIModelCapabilitiesSchema>;

/**
 * Per-token pricing in USD per million tokens.
 *
 * Used by providers that bill based on token consumption
 * (Anthropic direct, OpenAI direct, NanoGPT, etc.).
 */
export const TokenPricingSchema = z.object({
  /** Cost per million input tokens (USD). */
  inputPerMillion: z.number(),
  /** Cost per million cache-read input tokens (USD). */
  inputCachedPerMillion: z.number().optional(),
  /** Cost per million cache-write input tokens (USD). */
  cacheWritePerMillion: z.number().optional(),
  /** Cost per million output tokens (USD). */
  outputPerMillion: z.number(),
});

/**
 * Inferred type for per-token pricing.
 */
export type TokenPricing = z.infer<typeof TokenPricingSchema>;

/**
 * Per-request pricing in provider-defined units.
 *
 * Used by subscription-based providers (GitHub Copilot premium requests, etc.).
 * The multiplier expresses cost relative to one billing unit:
 * - `0` — free (no premium request consumed)
 * - `0.33` — costs 1/3 of a premium request
 * - `1` — costs one full premium request
 * @example GitHub Copilot Haiku
 * ```ts
 * { multiplier: 0.33 }  // 300 premium requests → 900 Haiku prompts
 * ```
 */
export const RequestPricingSchema = z.object({
  /** Cost per request in provider billing units (0 = free). */
  multiplier: z.number(),
});

/**
 * Inferred type for per-request pricing.
 */
export type RequestPricing = z.infer<typeof RequestPricingSchema>;

/**
 * Composable pricing model — dimensions are independent and optional.
 *
 * A model can have per-token pricing, per-request pricing, both, or neither.
 * This supports providers with different billing models (token-based, subscription-based,
 * or hybrid combinations).
 */
export const AIModelPricingSchema = z.object({
  /** Per-token pricing (Anthropic direct, OpenAI direct, etc.). */
  token: TokenPricingSchema.optional(),
  /** Per-request pricing (GitHub Copilot premium requests, etc.). */
  request: RequestPricingSchema.optional(),
});

/**
 * Inferred type for composable model pricing.
 */
export type AIModelPricing = z.infer<typeof AIModelPricingSchema>;

/**
 * Supplementary model metadata populated by rich provider APIs.
 *
 * Not used for routing or adapter logic — purely informational for
 * display, cost estimation, and generation-time enrichment.
 * Providers like NanoGPT return this data; leaner APIs (Anthropic, Z.AI) don't.
 */
export const AIModelMetadataSchema = z.object({
  /** Maximum output tokens the provider allows for this model. */
  maxOutputTokens: z.number().optional(),
  /** Provider-scoped capabilities for this model offering. */
  capabilities: AIModelCapabilitiesSchema.optional(),
  /** Token pricing for this model offering. */
  pricing: AIModelPricingSchema.optional(),
  /** Whether this model is included in the provider's subscription plan. */
  includedInSubscription: z.boolean().optional(),
  /** Optional description of the model **/
  description: z.string().optional(),
});

/**
 * Inferred type for model metadata.
 */
export type AIModelMetadata = z.infer<typeof AIModelMetadataSchema>;

/**
 * Canonical AI model descriptor.
 *
 * Single source of truth for model metadata across the platform.
 * Used in provider presets, adapter responses, settings storage, and UI.
 *
 * Core fields (name, contextWindowSize, etc.) are used by adapters, routing,
 * and UI selection. The optional `metadata` bag
 * carries supplementary information from rich provider APIs.
 */
export const AIModelSchema = z.object({
  /** Model identifier used by the provider (e.g., 'claude-sonnet-4-6', 'gpt-4o', 'gemini-2.5-pro'). */
  name: z.string(),

  /** Human-readable display name (e.g., 'Sonnet 4.5', 'GPT-4o'). */
  friendlyName: z.string().optional(),

  /** Model family name (e.g., 'opus', 'sonnet', 'gpt-4o'). Used for alias resolution and UI grouping. */
  family: z.string().optional(),

  /** Maximum context window size in tokens. */
  contextWindowSize: z.number(),

  /** Lab that created this model (e.g., 'anthropic', 'openai', 'google'). */
  labId: z.string(),

  /**
   * Maps supported reasoning levels to provider-native values.
   * When omitted, the model does not support extended thinking / reasoning.
   */
  supportedReasoningLevels: ReasoningLevelMapSchema.optional(),

  /**
   * Supplementary metadata from rich provider APIs (pricing, capabilities, etc.).
   * Not used for routing or adapter logic — purely informational.
   */
  metadata: AIModelMetadataSchema.optional(),
});

/**
 * Inferred type for canonical model descriptors.
 */
export type AIModel = z.infer<typeof AIModelSchema>;

/**
 * Provider-resolved AI model descriptor.
 *
 * Structurally identical to {@link AIModel}. The distinct type name marks
 * explicit provider boundaries: provider `availableModels`,
 * fetcher return types, and bus response schemas.
 */
export type ProviderAIModel = AIModel;

/**
 * Zod schema for {@link ProviderAIModel}.
 */
export const ProviderAIModelSchema = AIModelSchema;

/**
 * Model descriptor returned by live provider fetchers.
 *
 * Like {@link AIModel} but with `labId` optional — fetchers for multi-lab
 * aggregators (GitHub Copilot, OpenRouter) cannot always determine the
 * originating lab. The registry generation script resolves lab assignment
 * during the merge phase.
 */
export type DiscoveredAIModel = Omit<AIModel, 'labId'> & { labId?: string };
