import { z } from 'zod';

/**
 * Per-model visibility state. Ordered: disabled → enabled → visible.
 *
 * - `disabled` — Model is off; cannot be used by profiles/workers or shown in picker.
 * - `enabled` — Model is usable by profiles/workers but hidden from the AgentPicker.
 * - `visible` — Model is usable and shown in the AgentPicker UI.
 */
export const ModelVisibilitySchema = z.enum(['disabled', 'enabled', 'visible']);
export type ModelVisibility = z.infer<typeof ModelVisibilitySchema>;

/**
 * Determines the default visibility state for models without explicit overrides.
 *
 * - `show-all` — All models default to `visible`. Suitable for curated providers (Anthropic, Gemini).
 * - `allowlist` — All models default to `disabled`. Suitable for firehose providers (NanoGPT, OpenRouter).
 */
export const ModelFilterModeSchema = z.enum(['allowlist', 'show-all']);
export type ModelFilterMode = z.infer<typeof ModelFilterModeSchema>;

/**
 * Resolves the effective visibility for a model given the provider's filter mode
 * and any per-model overrides.
 *
 * Pure function usable by both backend validation and frontend filtering.
 * @param modelName - The model identifier to resolve
 * @param filterMode - The provider's filter mode
 * @param overrides - Sparse per-model visibility overrides (nullable)
 * @returns The resolved visibility state
 */
export function resolveModelVisibility(
  modelName: string,
  filterMode: ModelFilterMode,
  overrides: Record<string, ModelVisibility> | null | undefined,
): ModelVisibility {
  return overrides?.[modelName] ?? (filterMode === 'allowlist' ? 'disabled' : 'visible');
}
