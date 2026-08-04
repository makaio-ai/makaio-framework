import { z } from 'zod';
import { createStorageNamespaceDefinition } from '@makaio/storage-core';
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
export const AgentStorageNamespace = createStorageNamespaceDefinition('agent', {
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
     * A whole-record write of a caller-held snapshot, so on an *existing* row it
     * may not carry every column: the ownership columns and the origin provider
     * session stay with the stored row, and a stored `disposed` status wins over
     * the snapshot's. Disposal is the agent's removal and is terminal (see
     * `updateStatus`); a snapshot read before it must not revive the row. On a
     * fresh row there is nothing to protect and the caller's record is stored
     * verbatim.
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
        /** {@link AgentStatusSchema}'s members, plus `'all'` for "do not filter". */
        // Derived from the contract enum rather than restated: a status added
        // there must widen this filter in the same commit, and a hand-copied
        // list is exactly what silently fails to.
        status: z.enum([...AgentStatusSchema.options, 'all'] as const).optional(),
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
     * Update agent status, optionally as a compare-and-swap.
     *
     * **`disposed` is terminal.** A row that already carries it never transitions
     * again, whatever `status` or `expectedStatus` the call names. Disposal is
     * the agent's removal, and ownership authority is a predicate over the agent
     * row: a status revived to `idle` would let a removed agent reserve and
     * settle again. Enforcing it here — rather than asking every lifecycle writer
     * to check first — is what makes the guarantee hold against a removal that
     * lands mid-start or mid-rehydrate.
     *
     * Subject: `storage:agent.updateStatus`
     * Type: Request (RPC)
     */
    updateStatus: {
      request: z.object({
        agentId: z.string(),
        status: AgentStatusSchema,
        /**
         * Only apply the write when the stored status is one of these.
         *
         * Omitted, the write is unconditional — the behavior every pre-existing
         * caller relies on. Supplied, it makes a lifecycle transition *refusable*,
         * which is what lets two runtimes arbitrate one in-flight start without
         * either of them reading first: a `starting → idle` completion and a
         * `starting → dead` recovery both name the state they believe they are
         * leaving, so the loser is told it lost instead of overwriting the winner.
         *
         * A read-then-write cannot give that guarantee — the row can change
         * between the read and the write — so the expectation travels *with* the
         * write and is evaluated by the same statement.
         *
         * The terminal-`disposed` rule outranks this field: naming `disposed` in
         * an expectation does not make a removed agent transitionable.
         */
        expectedStatus: z.array(AgentStatusSchema).nonempty().optional(),
      }),
      response: z.object({
        /**
         * Whether the agent row exists.
         *
         * Separate from `transitioned` because a write can fail to land for two
         * different reasons: the row is gone, or the row is there and refused —
         * by an unmet `expectedStatus`, or by the terminal-`disposed` rule, which
         * refuses even when no expectation was supplied. A refusal reports
         * `success: true, transitioned: false`.
         */
        success: z.boolean(),
        /** Whether this call is the one that wrote the status. */
        transitioned: z.boolean(),
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
     * The agent's ownership columns (currency pair, revision, fence) are
     * deliberately not expressible here: they may only be written under a claim
     * generation, through the `storage:sessionOwnership` seam. `adapterSessionId`
     * below is the immutable *origin* identity, not the currency.
     *
     * Subject: `storage:agent.updateRuntime`
     * Type: Request (RPC)
     */
    updateRuntime: {
      request: z
        .object({
          agentId: z.string(),
          adapterId: z.string().optional(),
          /** Provider-confirmed adapter session ID. Set during reconciliation when the provider confirms an idle fork child's session. */
          adapterSessionId: z.string().optional(),
          cwd: z.string().optional(),
          model: z.string().optional(),
          allowedDirectories: z.array(z.string()).optional(),
          /** Set a provider config ID, pass null to clear it, or omit to leave it unchanged. */
          providerConfigId: z.string().nullable().optional(),
        })
        .refine(
          (payload) =>
            payload.adapterId !== undefined ||
            payload.adapterSessionId !== undefined ||
            payload.cwd !== undefined ||
            payload.model !== undefined ||
            payload.allowedDirectories !== undefined ||
            payload.providerConfigId !== undefined,
          {
            message:
              'At least one runtime field (adapterId, adapterSessionId, cwd, model, allowedDirectories, or providerConfigId) must be provided',
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
