import { z } from 'zod';
import { BaseSdkMessageSchema } from './base.js';

/**
 * API key source for authentication
 *
 * SDK Reference: ApiKeySource from \@anthropic-ai/claude-agent-sdk/sdkTypes.d.ts
 */
const ApiKeySourceSchema = z.enum(['user', 'project', 'org', 'temporary', 'none']);

/**
 * Permission mode for the Claude Code session
 */
const PermissionModeSchema = z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan']);

/**
 * MCP server status information
 */
const MCPServerSchema = z.object({
  name: z.string(),
  status: z.string(),
});

/**
 * Compact boundary metadata
 */
const CompactMetadataSchema = z.object({
  trigger: z.enum(['manual', 'auto']),
  pre_tokens: z.number(),
});

/**
 * System init message schema
 * Sent at the start of a session to communicate system state, available tools, and configuration
 */
export const SDKSystemInitMessageSchema = BaseSdkMessageSchema.extend({
  type: z.literal('system'),
  subtype: z.literal('init'),
  agents: z.array(z.string()).optional(),
  apiKeySource: ApiKeySourceSchema,
  cwd: z.string(),
  tools: z.array(z.string()),
  mcp_servers: z.array(MCPServerSchema),
  model: z.string(),
  permissionMode: PermissionModeSchema,
  slash_commands: z.array(z.string()),
  output_style: z.string(),
});

/**
 * System compact boundary message schema
 * Sent when conversation context is compacted to manage token limits
 * @see SDKCompactBoundaryMessage from \@anthropic-ai/claude-agent-sdk
 */
export const SDKSystemCompactBoundaryMessageSchema = BaseSdkMessageSchema.extend({
  type: z.literal('system'),
  subtype: z.literal('compact_boundary'),
  compact_metadata: CompactMetadataSchema,
});

/**
 * Discriminated union of all system message types
 */
export const SDKSystemMessageSchema = z.discriminatedUnion('subtype', [
  SDKSystemInitMessageSchema,
  SDKSystemCompactBoundaryMessageSchema,
]);

export type SDKSystemMessage = z.infer<typeof SDKSystemMessageSchema>;
