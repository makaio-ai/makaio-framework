import { z } from 'zod';
import { ContextModeSchema } from '@makaio/contracts';
import type { SchemaRecord } from '@makaio/core';

// ============================================================================
// SubagentTemplate Definition Schemas
// ============================================================================

/**
 * SubagentTemplate - User-configured template stored in settings.
 *
 * A convenience layer over the Subagent system for user-configured background
 * tasks. Not to be confused with WorkerNode (one-shot workflow execution unit).
 */
export const SubagentTemplateSchema = z.object({
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

export type SubagentTemplate = z.infer<typeof SubagentTemplateSchema>;

/**
 * Summary schema for listing subagent templates.
 */
export const SubagentTemplateSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  adapterName: z.string(),
  model: z.string().optional(),
  enabled: z.boolean(),
});

export type SubagentTemplateSummary = z.infer<typeof SubagentTemplateSummarySchema>;

/**
 * Schema for creating a new subagent template.
 * Omits server-managed fields: id, scope, createdAt, updatedAt.
 */
export const SubagentTemplateCreateSchema = SubagentTemplateSchema.omit({
  id: true,
  scope: true,
  createdAt: true,
  updatedAt: true,
});

export type SubagentTemplateCreate = z.infer<typeof SubagentTemplateCreateSchema>;

/**
 * Schema for updating a subagent template.
 */
export const SubagentTemplateUpdateSchema = SubagentTemplateSchema.partial().required({ id: true });

export type SubagentTemplateUpdate = z.infer<typeof SubagentTemplateUpdateSchema>;

/**
 * Schema-only subagent template CRUD subjects used by the settings layer.
 *
 * Keeping these in the pure schema module avoids accidentally registering the
 * runtime subagent-template namespace when settings code only needs the
 * request/response contracts for `settings:subagentTemplate.*`.
 */
export const SubagentTemplateSettingsSchemas = {
  list: {
    request: z.object({}),
    response: z.object({ definitions: z.array(SubagentTemplateSummarySchema) }),
  },
  get: {
    request: z.object({
      id: z.string().optional(),
      name: z.string().optional(),
    }),
    response: SubagentTemplateSchema,
  },
  create: {
    request: SubagentTemplateCreateSchema,
    response: z.object({ id: z.string() }),
  },
  update: {
    request: SubagentTemplateUpdateSchema,
    response: z.object({ success: z.boolean() }),
  },
  delete: {
    request: z.object({ id: z.string() }),
    response: z.object({ success: z.boolean() }),
  },
} satisfies SchemaRecord;

// ============================================================================
// SubagentTemplate Instance Schemas (Runtime)
// ============================================================================

/**
 * SubagentTemplate Instance - Running execution backed by SubagentManager.
 */
export const SubagentTemplateInstanceSchema = z.object({
  instanceId: z.string(),
  definitionId: z.string(),
  definitionName: z.string(),
  subagentId: z.string(),
  childSessionId: z.string(),
  status: z.enum(['running', 'waiting_input', 'completed', 'failed', 'cancelled']),
  createdAt: z.string(),
});

export type SubagentTemplateInstance = z.infer<typeof SubagentTemplateInstanceSchema>;

/**
 * Schema for spawning a subagent template.
 */
export const SubagentTemplateSpawnRequestSchema = z.object({
  subagentTemplateName: z.string().describe('Name of the SubagentTemplate'),
  prompt: z.string().describe('Task for the subagent template'),
  sessionId: z.string().describe('Parent session ID'),
  overrides: z
    .object({
      model: z.string().optional(),
      systemPrompt: z.string().optional(),
      allowedTools: z.array(z.string()).optional(),
    })
    .optional()
    .describe('Runtime overrides for subagent template config'),
});

export type SubagentTemplateSpawnRequest = z.infer<typeof SubagentTemplateSpawnRequestSchema>;

/**
 * Schema for subagent template instance status query.
 */
export const SubagentTemplateInstanceStatusSchema = z.object({
  instanceId: z.string(),
  definitionName: z.string(),
  subagentId: z.string(),
  status: z.enum(['running', 'waiting_input', 'completed', 'failed', 'cancelled']),
  result: z.string().optional(),
  error: z.string().optional(),
  progress: z.array(z.string()).optional(),
});

export type SubagentTemplateInstanceStatus = z.infer<typeof SubagentTemplateInstanceStatusSchema>;

// ============================================================================
// SubagentTemplate Events
// ============================================================================

export const SubagentTemplateSpawnedEventSchema = z.object({
  instanceId: z.string(),
  subagentTemplateName: z.string(),
});

export const SubagentTemplateCompletedEventSchema = z.object({
  instanceId: z.string(),
  success: z.boolean(),
  result: z.string().optional(),
  error: z.string().optional(),
});

/**
 * Schema-only subagent template runtime subjects.
 *
 * The runtime namespace registration lives in `./namespace.ts`; this export is
 * safe to import from settings or tests that only need the contracts.
 */
export const SubagentTemplateKernelSchemas = {
  spawn: {
    request: SubagentTemplateSpawnRequestSchema,
    response: z.object({ instanceId: z.string() }),
  },
  get: {
    request: z.object({ instanceId: z.string() }),
    response: SubagentTemplateInstanceStatusSchema,
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
  spawned: SubagentTemplateSpawnedEventSchema,
  completed: SubagentTemplateCompletedEventSchema,
} satisfies SchemaRecord;
