import { z } from 'zod';
import { CompressionModeSchema } from './compression.js';
import { AdapterSessionCurrencyStateSchema, AgentRoleSchema } from './primitives.js';

/**
 * Agent lifecycle status.
 * - 'starting': The agent row exists and its start is in flight; no connector is
 *   confirmed yet. Distinct from `'idle'` because a caller that persists the row
 *   before dispatching cannot claim connector readiness, and `'idle'` already
 *   means exactly that — a consumer seeing `'idle'` will use the agent without
 *   rehydrating it.
 * - 'idle': Connector ready, no active turn
 * - 'active': Turn in progress
 * - 'dead': Connector lost, awaiting rehydration
 * - 'disposed': Agent replaced (cross-adapter switch) — retained for message metadata
 *
 * **`'disposed'` is terminal.** Storage refuses every later transition out of it,
 * on both the compare-and-swap seam (`storage:agent.updateStatus`) and the
 * whole-record one (`storage:agent.set`, whose conflict path keeps the stored
 * value). Ownership authority is a predicate over this column, so a revived
 * status would let a removed agent reserve and settle again.
 *
 * **Status is never liveness evidence.** Whether a `'starting'` row belongs to an
 * attempt that is still running, or to a process that died mid-start, is decided
 * by the starting runtime's own in-flight registry and by a compare-and-swap on
 * this column (`storage:agent.updateStatus`'s `expectedStatus`) — never by
 * reading the status alone.
 */
export const AgentStatusSchema = z.enum(['starting', 'idle', 'active', 'dead', 'disposed']);
export type AgentStatus = z.infer<typeof AgentStatusSchema>;

/**
 * Schema for an agent attached to a makaio session.
 *
 * Represents the persistent agent state. The agent is a stable identity
 * shell; the connector is ephemeral and recreated on startup.
 */
export const MakaioSessionAgentSchema = z.object({
  /** Unique agent execution unit ID (stable across connector swaps and restarts) */
  agentId: z.string(),
  /** Adapter instance that owns this agent */
  adapterId: z.string(),
  /** Adapter type name (e.g., 'claude-code', 'copilot') */
  adapterName: z.string(),
  /** Makaio session this agent belongs to */
  sessionId: z.string(),
  /** Runtime process currently hosting this agent, independent of provider-session claims. */
  runtimeOwner: z
    .object({
      machineId: z.string(),
      instanceId: z.string(),
    })
    .optional(),
  /**
   * Opaque identity of the recovery attempt currently holding this row in
   * `starting`. It fences terminal recovery writes even when a later attempt
   * targets the same runtime binding.
   */
  recoveryAttemptId: z.string().optional(),
  /**
   * Provider's session ID — the agent's **immutable origin identity**.
   *
   * Records which provider session the agent started from, never where that
   * conversation moved to. The currency fields below carry the movement; pair
   * them through `resolveResumableAdapterSessionId` rather than reading either
   * half alone.
   *
   * Immutable is enforced, not merely intended: a whole-record
   * `storage:agent.set` writes this only when it creates the row. On an existing
   * agent the stored origin wins, so a caller writing a snapshot that never read
   * it — or read it before it was written — cannot erase the only resumable
   * provider ID an `inherited` agent has. `storage:agent.updateRuntime` is the
   * seam for changing it, and only when the caller actually supplies one.
   */
  adapterSessionId: z.string().optional(),
  /**
   * Provider-confirmed session ID that currently carries this agent's
   * conversation. Meaningful only while the state below is `'confirmed'`.
   *
   * Read-only projection: written exclusively through the
   * `storage:sessionOwnership` seam. Whole-record `storage:agent.set` and
   * `storage:agent.updateRuntime` never write it, so a writer holding a
   * pre-movement snapshot cannot resurrect an abandoned provider session.
   */
  currentAdapterSessionId: z.string().optional(),
  /**
   * Currency state of this agent's provider-native resume identity —
   * `inherited`, `moved` or `confirmed`, as defined by
   * {@link AdapterSessionCurrencyStateSchema}.
   *
   * Read-only projection — see {@link MakaioSessionAgentSchema.currentAdapterSessionId}.
   */
  currentAdapterSessionIdState: AdapterSessionCurrencyStateSchema.optional(),
  /**
   * Compare-and-swap revision of this agent's currency, bumped exclusively by
   * the `storage:sessionOwnership` seam. Callers pass the value they read as
   * `expectedRevision` when settling, which is what orders two writes inside one
   * claim generation.
   *
   * Read-only projection — see {@link MakaioSessionAgentSchema.currentAdapterSessionId}.
   */
  revision: z.number().int().nonnegative().optional(),
  /**
   * Fence of the claim generation that last wrote this agent's currency; 0 when
   * it has never been written. A settle carrying a lower fence is a stale owner
   * from a superseded generation and is refused.
   *
   * Read-only projection — see {@link MakaioSessionAgentSchema.currentAdapterSessionId}.
   */
  currencyFence: z.number().int().nonnegative().optional(),
  /** Current model identifier */
  model: z.string().optional(),
  /** Current working directory */
  cwd: z.string().optional(),
  /** Directory restrictions for file-system tool execution. */
  allowedDirectories: z.array(z.string()).optional(),
  /** Provider config UUID for credential/endpoint resolution */
  providerConfigId: z.string().optional(),
  /** Persona used to configure this agent (if any). */
  personaId: z.string().optional(),
  /** Profile used to configure this agent (if any). */
  profileId: z.string().optional(),
  /** Resolved harness ID for this agent. */
  harnessId: z.string().optional(),
  /** Client identifier for the client application this agent runs under (e.g., 'claude-code', 'codex'). Omit for API-only adapters. */
  clientId: z.string().optional(),
  /** Compression mode for session context management. */
  compressionMode: CompressionModeSchema.optional(),
  /** Agent's role in the session */
  role: AgentRoleSchema,
  /** Agent lifecycle status */
  status: AgentStatusSchema,
  /** Timestamp when agent was created (= when added to session) */
  createdAt: z.number(),
  /** Timestamp of last activity (message sent/received) */
  lastActivityAt: z.number(),
});

export type MakaioSessionAgent = z.infer<typeof MakaioSessionAgentSchema>;
