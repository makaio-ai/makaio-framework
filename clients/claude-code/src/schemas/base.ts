import { z } from 'zod';

/**
 * Default agent ID used by the Claude Code SDK for the primary (non-subagent)
 * conversation. Subagents receive their own UUID-based agent IDs.
 */
export const DEFAULT_SDK_AGENT_ID = 'main';

/**
 * Base SDK message schema with common fields.
 *
 * Represents the raw shape emitted by the Claude SDK. `agentId` is optional
 * here because it is a Makaio enrichment field injected by the connector
 * layer, not a native SDK field. Use {@link EnrichedBaseSdkMessageSchema}
 * when consuming bus events that have already been enriched.
 */
export const BaseSdkMessageSchema = z.object({
  /** Unique message identifier */
  uuid: z.string(),

  /** Session identifier */
  session_id: z.string(),

  /** Message type (will be overridden) */
  type: z.string(),

  correlation_id: z.string().optional(),

  /** Makaio agent identity — injected by the connector, absent in raw SDK payloads */
  agentId: z.string().optional(),

  /** ISO timestamp when the message was created */
  timestamp: z.string().optional(),

  /** Working directory where Claude Code is running */
  cwd: z.string().optional(),
});

/**
 * Base SDK message schema with parent tool tracking.
 * Used for messages that can be part of a tool execution chain.
 */
export const BaseSdkMessageWithParentToolSchema = BaseSdkMessageSchema.extend({
  /** Parent tool use ID if this message is part of a tool execution */
  parent_tool_use_id: z.string().nullable().optional(),
});

/**
 * Enriched base schema for bus-emitted SDK messages that have passed through
 * the connector `emit()` layer. Guarantees `agentId` is present.
 */
export const EnrichedBaseSdkMessageSchema = BaseSdkMessageSchema.required({ agentId: true });

/**
 * Enriched base schema with parent tool tracking.
 */
export const EnrichedBaseSdkMessageWithParentToolSchema = EnrichedBaseSdkMessageSchema.extend({
  /** Parent tool use ID if this message is part of a tool execution */
  parent_tool_use_id: z.string().nullable().optional(),
});
