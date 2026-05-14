import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import type { SchemaRecord } from '@makaio/core';
import { AIModelSchema } from '@makaio/contracts';

export const ProviderRuntimeSchemas = {
  fetchModels: {
    request: z
      .object({
        providerConfigId: z.string(),
      })
      .strict(),
    response: z
      .object({
        models: z.array(AIModelSchema),
      })
      .strict(),
  },
} satisfies SchemaRecord;

/**
 * Runtime-only provider namespace.
 */
export const ProviderRuntimeNamespace = createBusNamespace('providerRuntime', ProviderRuntimeSchemas);

/**
 * Pre-resolved provider runtime subjects for direct import.
 */
export const ProviderRuntimeSubjects = ProviderRuntimeNamespace.subjects;
