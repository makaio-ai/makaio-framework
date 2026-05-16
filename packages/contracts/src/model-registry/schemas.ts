import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

/** SDK-safe model descriptor exposed by the model registry bus seam. */
export const ModelRegistrySupportedModelSchema = z.object({
  /** Provider-native model identifier. */
  name: z.string(),
  /** Human-readable model name, when known. */
  friendlyName: z.string().optional(),
  /** Maximum context window size in tokens. */
  contextWindowSize: z.number().int().nonnegative(),
  /** Provider identifier that serves this model. */
  provider: z.string(),
});

/** Model registry bus schemas shared by framework services and SDK callers. */
export const ModelRegistrySchemas = {
  /**
   * List SDK-safe model descriptors across all registered providers.
   *
   * Subject: `modelRegistry:public.supportedModels`
   * Type: Request/Response
   * Handler: ModelRegistryService
   */
  supportedModels: {
    request: z.object({}),
    response: z.object({
      /** Models grouped by provider registry order. */
      models: z.array(ModelRegistrySupportedModelSchema),
    }),
  },
} satisfies SchemaRecord;

/** Inferred SDK-safe supported-model descriptor. */
export type ModelRegistrySupportedModel = z.infer<typeof ModelRegistrySupportedModelSchema>;

/** Request payload for `modelRegistry:public.supportedModels`. */
export type ModelRegistrySupportedModelsRequest = z.infer<typeof ModelRegistrySchemas.supportedModels.request>;

/** Response payload for `modelRegistry:public.supportedModels`. */
export type ModelRegistrySupportedModelsResponse = z.infer<typeof ModelRegistrySchemas.supportedModels.response>;
