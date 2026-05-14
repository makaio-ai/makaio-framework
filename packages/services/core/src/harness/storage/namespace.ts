import { z } from 'zod';
import { createStorageNamespaceDefinition } from '@makaio/storage-core';
import {
  ApprovalPolicySchema,
  HarnessDefinitionBaseSchema,
  HarnessDefinitionSchema,
  type HarnessDefinition,
} from '@makaio/contracts';
import { harnessDefinitions } from './schema.js';

const HarnessToolSelectionInputSchema = z.object({
  enabled: z.array(z.string()),
  disabled: z.array(z.string()),
});

const HarnessInputSchema = HarnessDefinitionBaseSchema.omit({
  createdAt: true,
  updatedAt: true,
  approvalPolicy: true,
  isDefault: true,
  enabled: true,
  nativeTools: true,
  registryTools: true,
  skills: true,
})
  .extend({
    approvalPolicy: ApprovalPolicySchema,
    isDefault: z.boolean(),
    enabled: z.boolean(),
    nativeTools: HarnessToolSelectionInputSchema,
    registryTools: HarnessToolSelectionInputSchema,
    skills: HarnessToolSelectionInputSchema.optional(),
  })
  // Strict mode is intentional: harness configs define runtime/tool policy and should reject unknown fields.
  .strict()
  .refine((data) => Boolean(data.adapterName) || Boolean(data.clientId), {
    message: 'At least one of adapterName or clientId must be set',
  });

const HarnessListQuerySchema = z.object({
  adapterName: z.string().optional(),
  clientId: z.string().optional(),
  name: z.string().optional(),
});

export const HarnessStorageNamespace = createStorageNamespaceDefinition('harness', {
  schemas: {
    get: {
      request: z.object({ id: z.string() }),
      response: z.object({ harness: HarnessDefinitionSchema.nullable() }),
    },
    set: {
      request: z.object({ harness: HarnessInputSchema }),
      response: z.object({ id: z.string() }),
    },
    delete: {
      request: z.object({ id: z.string() }),
      response: z.object({ deleted: z.boolean() }),
    },
    list: {
      request: HarnessListQuerySchema,
      response: z.object({ harnesses: z.array(HarnessDefinitionSchema) }),
    },
  },
  extensions: {
    drizzle: { harnessDefinitions },
  },
});

export const HarnessStorageSubjects = HarnessStorageNamespace.subjects;

export type Harness = HarnessDefinition;
export type HarnessInput = z.infer<typeof HarnessInputSchema>;
export type HarnessListQuery = z.infer<typeof HarnessListQuerySchema>;
