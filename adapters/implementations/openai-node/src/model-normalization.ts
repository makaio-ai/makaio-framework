import type { DiscoveredAIModel } from '@makaio/contracts';

/**
 * Raw model data from OpenAI /v1/models endpoint.
 * Field names vary across providers implementing the OpenAI API.
 */
export interface RawModelData {
  id?: string;
  name?: string;
  display_name?: string;
  context_length?: number;
  [key: string]: unknown;
}

/**
 * Normalize OpenAI model response to AIModel format.
 *
 * Handles variance in field names across OpenAI-compatible providers:
 * - NanoGPT: context_length, name
 * - Z.AI: (no context_length)
 * - Moonshot: context_length
 * - Kimi: context_length, display_name
 * @param raw - Raw model data from provider API
 * @param labId - Lab identifier to assign (omit for multi-lab providers)
 * @returns Normalized model descriptor
 */
export function normalizeOpenAIModel(raw: RawModelData, labId?: string): DiscoveredAIModel {
  return {
    name: raw.id ?? raw.name ?? 'unknown',
    friendlyName: raw.name ?? raw.display_name,
    contextWindowSize: raw.context_length ?? 0,
    ...(labId ? { labId } : {}),
  };
}

/**
 * Normalize array of raw model data from OpenAI /v1/models endpoint.
 * @param rawModels - Array of raw model data
 * @param labId - Lab identifier to assign (omit for multi-lab providers)
 * @returns Array of normalized model objects
 */
export function normalizeOpenAIModels(rawModels: RawModelData[], labId?: string): DiscoveredAIModel[] {
  return rawModels.map((raw) => normalizeOpenAIModel(raw, labId));
}
