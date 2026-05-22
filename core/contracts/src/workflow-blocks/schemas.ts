import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';

/**
 * Shared metadata schema for registered workflow blocks (trigger or step).
 */
const RegisteredBlockMetadataSchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string(),
  categories: z.array(z.string()).optional(),
  extensionName: z.string(),
});

/**
 * Zod schema for registered trigger block metadata (including owning extension).
 */
const RegisteredTriggerBlockSchema = z.object({
  metadata: RegisteredBlockMetadataSchema,
  configSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
});

/**
 * Zod schema for registered step block metadata (including owning extension).
 */
const RegisteredStepBlockSchema = z.object({
  metadata: RegisteredBlockMetadataSchema,
  configSchema: z.record(z.string(), z.unknown()),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
});

/**
 * Bus subject schemas for the workflow-blocks namespace.
 *
 * Each key maps to a subject name (prefixed with `workflow-blocks.` by the
 * namespace registration). RPC subjects carry `{ request, response }` pairs;
 * events are bare Zod schemas.
 */
export const WorkflowBlocksSchemas = {
  /**
   * List all registered trigger and step blocks.
   *
   * Subject: `workflow-blocks.list`
   */
  list: {
    request: z.object({}),
    response: z.object({
      triggers: z.array(RegisteredTriggerBlockSchema),
      steps: z.array(RegisteredStepBlockSchema),
    }),
  },

  /**
   * Emitted when an extension registers or deregisters its blocks.
   *
   * Subject: `workflow-blocks.changed`
   */
  changed: z.object({
    /** Name of the extension whose blocks changed. */
    extensionName: z.string(),
    /** Monotonically increasing global counter for change ordering. */
    revision: z.number().int().nonnegative(),
    /** Whether the change was a registration or deregistration. */
    reason: z.enum(['registered', 'deregistered']),
  }),
} satisfies SchemaRecord;
