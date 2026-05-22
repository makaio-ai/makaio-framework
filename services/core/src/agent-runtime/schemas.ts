import { z } from 'zod';
import { AgentSelectionBaseSchema, type AgentSelection, type AgentSelectionBase } from '@makaio/contracts/adapter';

const TRANSIENT_AGENT_SELECTION_KINDS = ['canonical-model'] as const;
const TRANSIENT_AGENT_SELECTION_KIND_SET = new Set<string>(TRANSIENT_AGENT_SELECTION_KINDS);

type TransientAgentSelectionKind = (typeof TRANSIENT_AGENT_SELECTION_KINDS)[number];

/**
 * Runtime spawn only accepts fully resolved agent selections.
 */
export type AgentRuntimeSelection = Exclude<AgentSelection, { kind: TransientAgentSelectionKind }>;

/**
 * Returns whether a base selection is safe to pass through the runtime spawn seam.
 * @param selection - Agent selection candidate received at the runtime boundary.
 * @returns `true` when the selection is already resolved for runtime spawn.
 */
function isAgentRuntimeSelection(selection: AgentSelectionBase): selection is AgentRuntimeSelection {
  return !TRANSIENT_AGENT_SELECTION_KIND_SET.has(selection.kind);
}

/**
 * Runtime agent selections are already past the high-level resolution seam.
 *
 * `canonical-model` is a transient selection kind: callers must resolve it via
 * `AgentResolutionSubjects.resolve` before spawning an agent runtime instance.
 */
export const AgentRuntimeSelectionSchema = AgentSelectionBaseSchema.refine(isAgentRuntimeSelection, {
  path: ['kind'],
  message: 'canonical-model selections must resolve before agentRuntime.spawn',
});

// ============================================================================
// Agent Runtime Instance Status
// ============================================================================

/**
 * Status of a running agent instance spawned via `AgentRuntimeSubjects.spawn`.
 *
 * Kind-agnostic replacement for `PersonaInstanceStatus` / `ProfileInstanceStatus`.
 * The `kind` and `sourceId` fields tell the caller what was resolved.
 */
export const AgentInstanceStatusSchema = z.object({
  /** Unique instance ID (returned from spawn). */
  instanceId: z.string(),

  /** The `kind` from the original `AgentSelection` (e.g., `'persona'`, `'profile'`). */
  kind: z.string(),

  /**
   * Human-readable name of the resolved entity.
   *
   * For personas: the persona name. For profiles: the profile name.
   * Populated by the host-tier handler during spawn.
   */
  displayName: z.string(),

  /** Underlying subagent ID (for correlation with `SubagentSubjects`). */
  subagentId: z.string(),

  /** Current execution status. */
  status: z.enum(['running', 'waiting_input', 'completed', 'failed', 'cancelled']),

  /** Final result (when status is `'completed'`). */
  result: z.string().optional(),

  /** Error message (when status is `'failed'`). */
  error: z.string().optional(),

  /** Progress updates emitted during execution. */
  progress: z.array(z.string()).optional(),
});

export type AgentInstanceStatus = z.infer<typeof AgentInstanceStatusSchema>;

// ============================================================================
// Agent Runtime Schemas
// ============================================================================

/**
 * Schemas for the `agentRuntime` bus namespace.
 *
 * Framework-tier spawn/get/send/kill protocol for tool-spawned agents.
 * Replaces `PersonaRuntimeSubjects` and `ProfileRuntimeSubjects` as the
 * single interface framework tools use to spawn agents by runtime-compatible
 * selections. Transient selections such as `canonical-model` must resolve
 * before this boundary.
 *
 * Host packages register the handler that dispatches on `agent.kind` to
 * the appropriate domain service (PersonaService, ProfileService, etc.).
 */
export const AgentRuntimeSchemas = {
  /**
   * Spawn an agent from a runtime-compatible selection.
   *
   * Subject: `agentRuntime.spawn`
   * Type: Request (RPC)
   *
   * The host-tier handler resolves the selection (persona → profile → config),
   * creates a subagent via `SubagentSubjects.spawn`, and returns the instance ID.
   * @example
   * ```typescript
   * // Framework tool spawns by persona ID (no host imports needed)
   * const { instanceId } = await bus.request(AgentRuntimeSubjects.spawn, {
   *   agent: { kind: 'persona', personaId: 'p-123' },
   *   prompt: 'Explore the authentication module',
   *   sessionId: parentSessionId,
   * });
   * ```
   */
  spawn: {
    request: z.object({
      /** Agent selection after transient high-level kinds have been resolved. */
      agent: AgentRuntimeSelectionSchema,
      /** Task prompt for the spawned agent. */
      prompt: z.string(),
      /** Parent session ID for subagent tracking. */
      sessionId: z.string(),
      /** Project scope for entity resolution. */
      projectId: z.string().optional(),
    }),
    response: z.object({
      /** Unique instance ID for subsequent get/send/kill calls. */
      instanceId: z.string(),
    }),
  },

  /**
   * Get the status of a spawned agent instance.
   *
   * Subject: `agentRuntime.get`
   * Type: Request (RPC)
   */
  get: {
    request: z.object({
      /** Instance ID returned from spawn. */
      instanceId: z.string(),
    }),
    response: AgentInstanceStatusSchema,
  },

  /**
   * Send a message to a running agent instance.
   *
   * Subject: `agentRuntime.send`
   * Type: Request (RPC)
   */
  send: {
    request: z.object({
      /** Instance ID returned from spawn. */
      instanceId: z.string(),
      /** Message content to send. */
      content: z.string(),
    }),
    response: z.object({
      /** Whether the message was delivered. */
      sent: z.boolean(),
    }),
  },

  /**
   * Kill a running agent instance.
   *
   * Subject: `agentRuntime.kill`
   * Type: Request (RPC)
   */
  kill: {
    request: z.object({
      /** Instance ID returned from spawn. */
      instanceId: z.string(),
    }),
    response: z.object({
      /** Whether the instance was killed. */
      killed: z.boolean(),
    }),
  },

  /**
   * Emitted when an agent instance is spawned.
   *
   * Subject: `agentRuntime.spawned`
   * Type: Event (fire-and-forget)
   */
  spawned: z.object({
    /** Instance ID. */
    instanceId: z.string(),
    /** The `kind` from the original selection. */
    kind: z.string(),
    /** Human-readable name of the resolved entity. */
    displayName: z.string(),
  }),

  /**
   * Emitted when an agent instance completes or fails.
   *
   * Subject: `agentRuntime.completed`
   * Type: Event (fire-and-forget)
   */
  completed: z.object({
    /** Instance ID. */
    instanceId: z.string(),
    /** Whether the agent completed successfully. */
    success: z.boolean(),
    /** Final result (on success). */
    result: z.string().optional(),
    /** Error message (on failure). */
    error: z.string().optional(),
  }),
} satisfies import('@makaio/core').SchemaRecord;
