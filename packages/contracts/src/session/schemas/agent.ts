import { z } from 'zod';
import { CompressionModeSchema } from './compression.js';
import { AgentRoleSchema } from './primitives.js';

/**
 * Agent lifecycle status.
 * - 'idle': Connector ready, no active turn
 * - 'active': Turn in progress
 * - 'dead': Connector lost, awaiting rehydration
 * - 'disposed': Agent replaced (cross-adapter switch) — retained for message metadata
 */
export const AgentStatusSchema = z.enum(['idle', 'active', 'dead', 'disposed']);
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
  /** Provider's session ID for native resume support */
  adapterSessionId: z.string().optional(),
  /** Current model identifier */
  model: z.string().optional(),
  /** Current working directory */
  cwd: z.string().optional(),
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
