import { z } from 'zod';
import { ContextModeSchema } from '@makaio/contracts';
import type { SchemaRecord } from '@makaio/core';

// ============================================================================
// Worker Definition Schemas
// ============================================================================

/**
 * Worker Definition - User-configured template stored in settings.
 */
export const WorkerDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),

  // Subagent configuration
  adapterName: z.string(),
  providerConfigId: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  contextMode: ContextModeSchema.default('fresh'),

  // Tool restrictions
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),

  // Security boundaries
  allowedDirectories: z.array(z.string()).optional(),

  // Metadata
  scope: z.string(),
  enabled: z.boolean().default(true),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type WorkerDefinition = z.infer<typeof WorkerDefinitionSchema>;

/**
 * Summary schema for listing workers.
 */
export const WorkerDefinitionSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  adapterName: z.string(),
  model: z.string().optional(),
  enabled: z.boolean(),
});

export type WorkerDefinitionSummary = z.infer<typeof WorkerDefinitionSummarySchema>;

/**
 * Schema for creating a new worker definition.
 * Omits server-managed fields: id, scope, createdAt, updatedAt.
 */
export const WorkerDefinitionCreateSchema = WorkerDefinitionSchema.omit({
  id: true,
  scope: true,
  createdAt: true,
  updatedAt: true,
});

export type WorkerDefinitionCreate = z.infer<typeof WorkerDefinitionCreateSchema>;

/**
 * Schema for updating a worker definition.
 */
export const WorkerDefinitionUpdateSchema = WorkerDefinitionSchema.partial().required({ id: true });

export type WorkerDefinitionUpdate = z.infer<typeof WorkerDefinitionUpdateSchema>;

/**
 * Schema-only worker definition CRUD subjects used by the settings layer.
 *
 * Keeping these in the pure schema module avoids accidentally registering the
 * runtime worker namespace when settings code only needs the request/response
 * contracts for `settings:worker.*`.
 */
export const WorkerSettingsSchemas = {
  list: {
    request: z.object({}),
    response: z.object({ definitions: z.array(WorkerDefinitionSummarySchema) }),
  },
  get: {
    request: z.object({
      id: z.string().optional(),
      name: z.string().optional(),
    }),
    response: WorkerDefinitionSchema,
  },
  create: {
    request: WorkerDefinitionCreateSchema,
    response: z.object({ id: z.string() }),
  },
  update: {
    request: WorkerDefinitionUpdateSchema,
    response: z.object({ success: z.boolean() }),
  },
  delete: {
    request: z.object({ id: z.string() }),
    response: z.object({ success: z.boolean() }),
  },
} satisfies SchemaRecord;

// ============================================================================
// Worker Instance Schemas (Runtime)
// ============================================================================

/**
 * Worker Instance - Running execution backed by SubagentManager.
 */
export const WorkerInstanceSchema = z.object({
  instanceId: z.string(),
  definitionId: z.string(),
  definitionName: z.string(),
  subagentId: z.string(),
  childSessionId: z.string(),
  status: z.enum(['running', 'waiting_input', 'completed', 'failed', 'cancelled']),
  createdAt: z.string(),
});

export type WorkerInstance = z.infer<typeof WorkerInstanceSchema>;

/**
 * Schema for spawning a worker.
 */
export const WorkerSpawnRequestSchema = z.object({
  workerName: z.string().describe('Name of the Worker Definition'),
  prompt: z.string().describe('Task for the worker'),
  sessionId: z.string().describe('Parent session ID'),
  overrides: z
    .object({
      model: z.string().optional(),
      systemPrompt: z.string().optional(),
      allowedTools: z.array(z.string()).optional(),
    })
    .optional()
    .describe('Runtime overrides for worker config'),
});

export type WorkerSpawnRequest = z.infer<typeof WorkerSpawnRequestSchema>;

/**
 * Schema for worker instance status query.
 */
export const WorkerInstanceStatusSchema = z.object({
  instanceId: z.string(),
  definitionName: z.string(),
  subagentId: z.string(),
  status: z.enum(['running', 'waiting_input', 'completed', 'failed', 'cancelled']),
  result: z.string().optional(),
  error: z.string().optional(),
  progress: z.array(z.string()).optional(),
});

export type WorkerInstanceStatus = z.infer<typeof WorkerInstanceStatusSchema>;

// ============================================================================
// Worker Events
// ============================================================================

export const WorkerSpawnedEventSchema = z.object({
  instanceId: z.string(),
  workerName: z.string(),
});

export const WorkerCompletedEventSchema = z.object({
  instanceId: z.string(),
  success: z.boolean(),
  result: z.string().optional(),
  error: z.string().optional(),
});

/**
 * Schema-only worker runtime subjects.
 *
 * The runtime namespace registration lives in `./namespace.ts`; this export is
 * safe to import from settings or tests that only need the contracts.
 */
export const WorkerKernelSchemas = {
  spawn: {
    request: WorkerSpawnRequestSchema,
    response: z.object({ instanceId: z.string() }),
  },
  get: {
    request: z.object({ instanceId: z.string() }),
    response: WorkerInstanceStatusSchema,
  },
  send: {
    request: z.object({
      instanceId: z.string(),
      content: z.string(),
    }),
    response: z.object({ sent: z.boolean() }),
  },
  kill: {
    request: z.object({ instanceId: z.string() }),
    response: z.object({ killed: z.boolean() }),
  },
  spawned: WorkerSpawnedEventSchema,
  completed: WorkerCompletedEventSchema,
} satisfies SchemaRecord;
