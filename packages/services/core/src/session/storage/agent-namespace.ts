import { z } from 'zod';
import { createStorageNamespace } from '@makaio/storage-core';
import { MakaioSessionAgentSchema, AgentStatusSchema } from '@makaio/contracts';
import { agents } from './schema.js';

/**
 * Agent storage namespace.
 *
 * Provides bus subjects for agent CRUD operations and
 * Drizzle schemas for SQL-based persistence.
 * @example
 * ```typescript
 * import { AgentStorageSubjects } from '@makaio/services-core/session';
 *
 * const { agent } = await bus.request(AgentStorageSubjects.get, { agentId: '123' });
 * ```
 */
export const AgentStorageNamespace = createStorageNamespace('agent', {
  schemas: {
    /**
     * Get an agent by ID.
     *
     * Subject: `storage:agent.get`
     * Type: Request (RPC)
     */
    get: {
      request: z.object({
        agentId: z.string(),
      }),
      response: z.object({
        agent: MakaioSessionAgentSchema.nullable(),
      }),
    },

    /**
     * Store or update an agent.
     *
     * Subject: `storage:agent.set`
     * Type: Request (RPC)
     */
    set: {
      request: z.object({
        agentId: z.string(),
        agent: MakaioSessionAgentSchema,
      }),
      response: z.object({
        success: z.boolean(),
      }),
    },

    /**
     * Delete an agent by ID.
     *
     * Subject: `storage:agent.delete`
     * Type: Request (RPC)
     */
    delete: {
      request: z.object({
        agentId: z.string(),
      }),
      response: z.object({
        success: z.boolean(),
      }),
    },

    /**
     * List agents by adapter name with optional status filter.
     *
     * Subject: `storage:agent.listByAdapter`
     * Type: Request (RPC)
     */
    listByAdapter: {
      request: z.object({
        adapterName: z.string(),
        status: z.enum(['idle', 'active', 'dead', 'disposed', 'all']).optional(),
      }),
      response: z.object({
        agents: z.array(MakaioSessionAgentSchema),
      }),
    },

    /**
     * List agents by session ID.
     *
     * Subject: `storage:agent.listBySession`
     * Type: Request (RPC)
     */
    listBySession: {
      request: z.object({
        sessionId: z.string(),
      }),
      response: z.object({
        agents: z.array(MakaioSessionAgentSchema),
      }),
    },

    /**
     * Update agent status.
     *
     * Subject: `storage:agent.updateStatus`
     * Type: Request (RPC)
     */
    updateStatus: {
      request: z.object({
        agentId: z.string(),
        status: AgentStatusSchema,
      }),
      response: z.object({
        success: z.boolean(),
      }),
    },

    /**
     * Update agent last activity timestamp.
     *
     * Subject: `storage:agent.updateActivity`
     * Type: Request (RPC)
     */
    updateActivity: {
      request: z.object({
        agentId: z.string(),
        lastActivityAt: z.number(),
      }),
      response: z.object({
        success: z.boolean(),
      }),
    },

    /**
     * Update runtime-mutable agent fields without full record overwrite.
     *
     * Subject: `storage:agent.updateRuntime`
     * Type: Request (RPC)
     */
    updateRuntime: {
      request: z
        .object({
          agentId: z.string(),
          cwd: z.string().optional(),
          model: z.string().optional(),
          providerConfigId: z.string().optional(),
        })
        .refine(
          (payload) =>
            payload.cwd !== undefined || payload.model !== undefined || payload.providerConfigId !== undefined,
          {
            message: 'At least one runtime field (cwd, model, or providerConfigId) must be provided',
          },
        ),
      response: z.object({
        success: z.boolean(),
      }),
    },
  },
  extensions: {
    drizzle: {
      agents,
    },
  },
});

/**
 * Typed subjects for agent storage operations.
 */
export const AgentStorageSubjects = AgentStorageNamespace.subjects;
