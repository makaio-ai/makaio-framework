import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { JsonSchemaRecordSchema } from '../shared/json-value.js';
import { WorkflowDelegateResultFinalizerIdSchema } from '../workflow/finalization.js';

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
 * Zod schema for the `station` node run mapping on a registered step block.
 *
 * Mirrors {@link StationNodeBlockRun} for bus transport validation.
 * Validates that `prompt` is non-empty and `outputSchema` is a JSON Schema
 * document when present.
 */
const StationNodeBlockRunSchema = z.object({
  type: z.literal('station'),
  /** Task prompt template compiled into the station node. */
  prompt: z.string().min(1),
  /** Named role reference forwarded to the station node. */
  role: z.string().min(1).optional(),
  /**
   * JSON Schema document for the expected station output.
   * Validated as a JSON-safe record when present.
   */
  outputSchema: JsonSchemaRecordSchema.optional(),
  /** Timeout in milliseconds forwarded to the station node. */
  timeoutMs: z.number().int().positive().optional(),
});

/**
 * Zod schema for the `delegate-agent` node run mapping on a registered step block.
 *
 * Mirrors {@link DelegateAgentNodeBlockRun} for bus transport validation.
 */
const DelegateAgentNodeBlockRunSchema = z.object({
  type: z.literal('delegate-agent'),
  /** Identifier of the registered agent definition to invoke. */
  agentId: z.string().min(1),
  /** jexl expression template resolving to the agent input payload. */
  inputExpression: z.string().optional(),
  /**
   * JSON Schema document for the expected agent output.
   * Validated as a JSON-safe record when present.
   */
  outputSchema: JsonSchemaRecordSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  resultFinalizerId: WorkflowDelegateResultFinalizerIdSchema.optional(),
});

/**
 * Zod schema for the `delegate-role` node run mapping on a registered step block.
 *
 * Mirrors {@link DelegateRoleNodeBlockRun} for bus transport validation.
 */
const DelegateRoleNodeBlockRunSchema = z.object({
  type: z.literal('delegate-role'),
  /** Named role reference resolved at execution time. */
  role: z.string().min(1),
  /** Task prompt template forwarded to the delegate-role node. */
  prompt: z.string().min(1),
  /**
   * JSON Schema document for the expected delegation output.
   * Validated as a JSON-safe record when present.
   */
  outputSchema: JsonSchemaRecordSchema.optional(),
  allowedTools: z.array(z.string()).optional(),
  resultFinalizerId: WorkflowDelegateResultFinalizerIdSchema.optional(),
  /** Timeout in milliseconds forwarded to the delegate-role node. */
  timeoutMs: z.number().int().positive().optional(),
});

/**
 * Discriminated union schema for all supported step block run mappings.
 *
 * Each variant corresponds to a primitive node type the builder can compile the
 * step into. Extend by adding additional variants as new execution strategies
 * are introduced.
 */
const WorkflowStepBlockRunSchema = z.discriminatedUnion('type', [
  StationNodeBlockRunSchema,
  DelegateAgentNodeBlockRunSchema,
  DelegateRoleNodeBlockRunSchema,
]);

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
