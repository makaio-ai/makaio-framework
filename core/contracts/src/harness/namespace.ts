import { z } from 'zod';
import { createBusNamespace, type SchemaRecord } from '@makaio/core';
import { EntityUIConfigSchema } from '../shared/ui-config.js';
import { HarnessDefinitionCreateSchema, HarnessDefinitionSchema } from './schemas.js';

const HARNESS_GET_ID_OR_NAME_MESSAGE = 'Either id or name is required';
const HARNESS_GET_ADAPTER_REQUIRED_FOR_NAME_MESSAGE = 'adapterName is required when looking up by name';
const HARNESS_ADAPTER_OR_CLIENT_REQUIRED_MESSAGE = 'At least one of adapterName or clientId must be provided';

/**
 * Validate that at least one of adapterName or clientId is present.
 * @param data - Lookup payload candidate
 * @returns True when either `adapterName` or `clientId` is provided
 */
const requiresAdapterOrClient = (data: { adapterName?: string; clientId?: string }): boolean =>
  Boolean(data.adapterName || data.clientId);

/**
 * Validate harness lookup input.
 * @param lookup - Lookup payload candidate
 * @returns True when either `id` or `name` is provided
 */
function hasHarnessLookupKey(lookup: { id?: string; name?: string }): boolean {
  return Boolean(lookup.id || lookup.name);
}

/**
 * Validate deterministic harness name lookup.
 * @param lookup - Lookup payload candidate
 * @returns True when `adapterName` is provided for name-based lookup
 */
function hasAdapterForNameLookup(lookup: { id?: string; name?: string; adapterName?: string }): boolean {
  if (lookup.id || !lookup.name) {
    return true;
  }

  return Boolean(lookup.adapterName);
}

export const HarnessSchemas = {
  get: {
    request: z
      .object({
        id: z.string().optional(),
        name: z.string().optional(),
        adapterName: z.string().optional(),
      })
      .refine(hasHarnessLookupKey, {
        message: HARNESS_GET_ID_OR_NAME_MESSAGE,
        path: ['id'],
      })
      .refine(hasAdapterForNameLookup, {
        message: HARNESS_GET_ADAPTER_REQUIRED_FOR_NAME_MESSAGE,
        path: ['adapterName'],
      }),
    response: HarnessDefinitionSchema,
  },

  list: {
    request: z.object({
      adapterName: z.string().optional(),
      clientId: z.string().optional(),
      name: z.string().optional(),
    }),
    response: z.object({ harnesses: z.array(HarnessDefinitionSchema) }),
  },

  set: {
    request: HarnessDefinitionCreateSchema,
    response: z.object({ id: z.string() }),
  },

  delete: {
    request: z.object({ id: z.string() }),
    response: z.object({ success: z.boolean() }),
  },

  getDefault: {
    request: z
      .object({
        adapterName: z.string().optional(),
        /** Client identifier for client-scoped default harness lookup. */
        clientId: z.string().optional(),
      })
      .refine(requiresAdapterOrClient, {
        message: HARNESS_ADAPTER_OR_CLIENT_REQUIRED_MESSAGE,
        path: ['adapterName'],
      }),
    response: HarnessDefinitionSchema,
  },

  resolve: {
    request: z
      .object({
        adapterName: z.string().optional(),
        /** Client identifier for client-scoped harness resolution. */
        clientId: z.string().optional(),
        personaHarnessId: z.string().optional(),
        profileHarnessId: z.string().optional(),
      })
      .refine(requiresAdapterOrClient, {
        message: HARNESS_ADAPTER_OR_CLIENT_REQUIRED_MESSAGE,
        path: ['adapterName'],
      }),
    response: HarnessDefinitionSchema,
  },

  getSchema: {
    request: z.object({}),
    response: z.object({
      schema: z.record(z.string(), z.unknown()),
      uiConfig: EntityUIConfigSchema,
    }),
  },

  /** Emitted after a new harness definition is inserted. */
  created: HarnessDefinitionSchema,
  /** Emitted after an existing harness definition is updated. */
  updated: HarnessDefinitionSchema,
  /** Emitted after a harness definition is deleted. */
  deleted: z.object({ id: z.string() }),
} satisfies SchemaRecord;

export const HarnessNamespace = createBusNamespace('harness', HarnessSchemas);
export const HarnessSubjects = HarnessNamespace.subjects;
