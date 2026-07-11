import { z } from 'zod';
import { createBusNamespace } from '@makaio/core';
import type { SchemaRecord } from '@makaio/core';
import { AIModelSchema } from '@makaio/contracts';

export const ProviderRuntimeSchemas = {
  listModelFetchAdapters: {
    request: z
      .object({
        providerConfigId: z.string().trim().min(1),
      })
      .strict(),
    response: z
      .object({
        adapterNames: z.array(z.string().trim().min(1)),
      })
      .strict(),
  },
  fetchModels: {
    request: z
      .object({
        adapterName: z.string().trim().min(1),
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
