import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { WorkflowAgentStepNodeSchema } from '../workflow/schemas.js';

/**
 * Shared metadata schema for registered workflow step blocks.
 */
const RegisteredBlockMetadataSchema = z.object({
  name: z.string(),
  label: z.string(),
  description: z.string(),
  categories: z.array(z.string()).optional(),
  extensionName: z.string(),
});

// ─────────────────────────────────────────────────────────────
// Step Block Run Mapping Schemas
// ─────────────────────────────────────────────────────────────

/**
 * Zod schema for the `agent-step` node run mapping on a registered step block.
 *
 * Mirrors {@link AgentStepBlockRun} for bus transport validation. Picked from
 * {@link WorkflowAgentStepNodeSchema} so the run mapping stays in lockstep with
 * the compiled node's own validation.
 */
const AgentStepBlockRunSchema = WorkflowAgentStepNodeSchema.pick({
  type: true,
  role: true,
  prompt: true,
  outputSchema: true,
  allowedTools: true,
  resultFinalizerId: true,
  timeoutMs: true,
});

/**
 * Run mapping schema a registered step block can compile into.
 *
 * Extend by widening to a discriminated union as new execution strategies
 * are introduced.
 */
const WorkflowStepBlockRunSchema = AgentStepBlockRunSchema;

/**
 * Zod schema for registered step block metadata (including owning extension).
 */
const RegisteredStepBlockSchema = z.object({
  metadata: RegisteredBlockMetadataSchema,
  configSchema: z.record(z.string(), z.unknown()),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  runs: WorkflowStepBlockRunSchema,
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
   * List all registered step blocks.
   *
   * Workflow start conditions are not blocks: they are executable automation
   * trigger types discovered through `automation-triggers.list`.
   *
   * Subject: `workflow-blocks.list`
   */
  list: {
    request: z.object({}),
    response: z.object({
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
