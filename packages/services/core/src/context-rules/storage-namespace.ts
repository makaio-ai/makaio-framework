import { z } from 'zod';
import { createStorageNamespaceDefinition } from '@makaio/storage-core';
import { ContextRuleInputSchema, ContextRuleListQuerySchema, ContextRuleSchema } from './schemas.js';

/**
 * Storage namespace for persisted context rules.
 *
 * Storage owns CRUD and scope-based candidate listing only. Effective rule
 * resolution, sorting, evaluation, rendering, and grouping belong to the
 * service layer.
 */
export const ContextRulesStorageNamespace = createStorageNamespaceDefinition('contextRules', {
  schemas: {
    get: {
      request: z.object({ id: z.string() }),
      response: z.object({ rule: ContextRuleSchema.nullable() }),
    },
    set: {
      request: z.object({ rule: ContextRuleInputSchema }),
      response: z.object({ id: z.string() }),
    },
    delete: {
      request: z.object({ id: z.string() }),
      response: z.object({ deleted: z.boolean() }),
    },
    list: {
      request: ContextRuleListQuerySchema,
      response: z.object({ rules: z.array(ContextRuleSchema) }),
    },
  },
});

/**
 * Typed subjects for context-rule storage operations.
 */
export const ContextRulesStorageSubjects = ContextRulesStorageNamespace.subjects;
