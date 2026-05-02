import { z } from 'zod';
import type { SchemaRecord } from '@makaio/core';
import { ToolCapabilitySchema } from '../tool-capability/index.js';
import { ResolveEnrichedPolicySchema } from './enriched-policy.js';

/**
 * Approval schemas for tool call approval requests.
 *
 * Subject: `approval.request`
 * Type: Request (RPC)
 *
 * Emitted when: An agent requests approval before executing a tool call.
 * The UI handler must keep this request open until the user responds.
 * Bus timeouts should be set appropriately high for these requests.
 *
 * Response semantics:
 * - `action: 'allow'`: Approve tool execution, optionally with modified args
 * - `action: 'deny'`: Reject tool execution
 */
export const ApprovalSchemas = {
  ...ResolveEnrichedPolicySchema,
  request: {
    request: z.object({
      /** Unique approval request identifier */
      requestId: z.string(),
      /** Tool call identifier from the agent */
      toolCallId: z.string(),
      /** Name of the tool being called */
      toolName: z.string().optional(),
      /** Tool call arguments */
      args: z.record(z.string(), z.unknown()).optional(),
      /** Agent that initiated the tool call */
      agentId: z.string(),
      /** Makaio session identifier (required for transport-level routing to owning tab) */
      sessionId: z.string(),
      /** Adapter type name (e.g., 'claude-code') */
      adapterName: z.string(),
      /** Persona display name */
      personaName: z.string().optional(),
      /** Profile display name */
      profileName: z.string().optional(),
      /** Agent capability identifiers */
      capabilities: z.array(ToolCapabilitySchema).readonly().optional(),
      /** Risk classification for this tool call */
      riskLevel: z.enum(['safe', 'neutral', 'destructive']).optional(),
      /** LLM reasoning/thinking that preceded this tool call (when available) */
      reasoning: z.string().optional(),
      /** Unix timestamp (ms) when the request was created */
      createdAt: z.number(),
    }),
    response: z.discriminatedUnion('action', [
      z.object({
        /** Approval decision */
        action: z.literal('allow'),
        /** Modified tool arguments (only applicable when action is 'allow') */
        updatedInput: z.record(z.string(), z.unknown()).optional(),
      }),
      z.object({
        /** Approval decision */
        action: z.literal('deny'),
        /** Optional user-supplied reason for denying the tool call */
        message: z.string().optional(),
      }),
    ]),
  },
} satisfies SchemaRecord;

export type ApprovalRequest = z.infer<typeof ApprovalSchemas.request.request>;
export type ApprovalResponse = z.infer<typeof ApprovalSchemas.request.response>;
